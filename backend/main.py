from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os
import uuid
import tempfile
import fitz  # PyMuPDF
from sentence_transformers import SentenceTransformer
import chromadb
import whisper
import httpx
from pydantic import BaseModel

# Load environment variables
load_dotenv()

# Initialize embedder at module level (runs once at startup)
embedder = SentenceTransformer('all-MiniLM-L6-v2')

# Initialize ChromaDB persistent client
chroma_client = chromadb.PersistentClient(
    path=os.getenv("CHROMA_PATH", "./chroma_db")
)

# Get or create collection (safe across restarts — won't wipe existing data)
collection = chroma_client.get_or_create_collection("documents")

# Initialize Whisper model at module level (runs once at startup)
whisper_model = whisper.load_model(os.getenv("WHISPER_MODEL", "base.en"))

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


def chunk_text(text: str, chunk_size: int = 400, overlap: int = 50) -> list[str]:
    """
    Split text into overlapping chunks by words.

    Args:
        text: Input text to chunk
        chunk_size: Number of words per chunk
        overlap: Number of overlapping words between consecutive chunks

    Returns:
        List of text chunks
    """
    words = text.split()

    # Handle edge case: text is shorter than chunk_size
    if len(words) <= chunk_size:
        return [text]

    chunks = []
    step = chunk_size - overlap

    for i in range(0, len(words), step):
        chunk_words = words[i:i + chunk_size]
        chunk_str = ' '.join(chunk_words)  # renamed from chunk_text to avoid shadowing
        chunks.append(chunk_str)

        if i + chunk_size >= len(words):
            break

    return chunks


@app.post("/ingest")
async def ingest_pdf(file: UploadFile = File(...)):
    """
    Ingest a PDF file: extract text, chunk it, embed it, and store in ChromaDB.
    """
    # Validate file type before attempting to parse
    if file.content_type != "application/pdf" and not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    try:
        pdf_bytes = await file.read()

        if not pdf_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")

        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        except (fitz.FileDataError, RuntimeError):
            raise HTTPException(status_code=400, detail="Invalid or corrupted PDF")

        full_text = ""
        for page in doc:
            full_text += page.get_text()
        doc.close()

        if not full_text.strip():
            raise HTTPException(
                status_code=400,
                detail="No text could be extracted from the PDF. It may be scanned or image-based."
            )

        chunks = chunk_text(full_text)

        if not chunks:
            raise HTTPException(status_code=400, detail="Text could not be chunked properly.")

        embeddings = embedder.encode(chunks).tolist()

        doc_id = str(uuid.uuid4())
        chunk_ids = [f"{doc_id}_{i}" for i in range(len(chunks))]

        collection.add(
            documents=chunks,
            embeddings=embeddings,
            ids=chunk_ids
        )

        return {
            "status": "ingested",
            "chunks": len(chunks),
            "doc_id": doc_id
        }

    except HTTPException:
        # Let our own intentional 400s (and similar) pass through untouched
        raise
    except Exception as e:
        # Only genuinely unexpected errors become 500s
        raise HTTPException(status_code=500, detail=f"Error processing PDF: {str(e)}")


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Transcribe audio file using Whisper.
    """
    # Validate file type
    if not file.filename or not file.filename.lower().endswith(('.wav', '.mp3', '.m4a', '.flac', '.ogg')):
        raise HTTPException(
            status_code=400, 
            detail="Audio file must be in WAV, MP3, M4A, FLAC, or OGG format"
        )

    tmp_path = None
    try:
        # Read audio bytes
        audio_bytes = await file.read()
        
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Uploaded audio file is empty")
        
        # Create temp directory if it doesn't exist
        temp_dir = os.path.join(os.getcwd(), "temp_audio")
        os.makedirs(temp_dir, exist_ok=True)
        
        # Create a unique filename
        temp_filename = f"temp_{uuid.uuid4().hex[:8]}.wav"
        tmp_path = os.path.join(temp_dir, temp_filename)
        
        # Write the file directly
        with open(tmp_path, "wb") as f:
            f.write(audio_bytes)
        
        # Verify file was created and is readable
        if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
            raise HTTPException(status_code=500, detail="Temporary file creation failed")
        
        # Transcribe using Whisper with explicit settings for stability
        result = whisper_model.transcribe(
            tmp_path,
            temperature=0.0,
            fp16=False,  # Disable FP16 for CPU/Windows
            language="en",  # Force English for better accuracy
            task="transcribe"
        )
        
        transcript = result["text"].strip()
        
        if not transcript:
            return {"transcript": "No speech detected in the audio."}
        
        return {"transcript": transcript}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, 
            detail=f"Error transcribing audio: {str(e)}"
        )
    finally:
        # Clean up temp file in all cases
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                # Ignore deletion errors
                pass


# --- Pydantic models for request validation ---
class QueryRequest(BaseModel):
    question: str


@app.post("/query")
async def query_document(request: QueryRequest):
    """
    RAG query endpoint: retrieve relevant chunks and generate an answer using Ollama.
    """
    try:
        # 1. Embed the question
        question_embedding = embedder.encode([request.question]).tolist()[0]
        
        # 2. Query ChromaDB for top 4 most similar chunks
        results = collection.query(
            query_embeddings=[question_embedding],
            n_results=4
        )
        
        # 3. Extract chunks from results
        context_chunks = results["documents"][0] if results["documents"] else []
        
        # 4. Guard: if no chunks found, return early
        if not context_chunks:
            return {
                "answer": "I couldn't find relevant information in the document.",
                "sources": []
            }
        
        # 5. Build the prompt
        prompt = f"""You are a helpful assistant answering questions about an uploaded document.
Answer using ONLY the context below. If the context doesn't contain the answer, 
say "I couldn't find that in the document."
Keep your answer to 2-3 sentences since it will be read aloud.

Context:
{chr(10).join(context_chunks)}

Question: {request.question}
Answer:"""
        
        # 6. Call Ollama via httpx
        ollama_url = os.getenv("OLLAMA_URL", "http://localhost:11434") + "/v1/chat/completions"
        payload = {
            "model": "llama3.2:3b",
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "max_tokens": 150
        }
        
        async with httpx.AsyncClient(timeout=500.0) as client:
            response = await client.post(ollama_url, json=payload)
            response.raise_for_status()  # Raise for HTTP errors (4xx, 5xx)
        
        # 7. Extract answer from response
        answer = response.json()["choices"][0]["message"]["content"].strip()
        
        # 8. Return answer and sources
        return {
            "answer": answer,
            "sources": context_chunks
        }
        
    except httpx.ConnectError:
        # Ollama is not running or unreachable
        return {
            "answer": "Local AI model is not running. Please start Ollama.",
            "sources": []
        }
    except httpx.TimeoutException:
        return {
            "answer": "The model took too long to respond. Try a shorter question.",
            "sources": []
        }
    except Exception as e:
        # Catch any other unexpected errors and return a clean message
        raise HTTPException(
            status_code=500,
            detail=f"Query processing error: {str(e)}"
        )





