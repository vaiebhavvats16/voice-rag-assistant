# 🎤 VoiceRAG — Voice-Powered Document Q&A

> Ask your documents questions — out loud. Get answers spoken back. No cloud. No API keys. No data leaving your machine.

[![Python](https://img.shields.io/badge/Python-3.11-blue?style=flat-square&logo=python)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.111-009688?style=flat-square&logo=fastapi)](https://fastapi.tiangolo.com)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

---

## 🔗 Live Demo

**Frontend:** [voice-rag.vercel.app](https://voice-rag.vercel.app)

> ⚠️ The hosted demo uses Groq API for inference. The local version runs **entirely offline** — no API calls after setup. See [Running Locally](#-getting-started) for the full experience.

---

## 📸 Screenshots

### Main Interface
<img width="1917" height="1078" alt="Screenshot 2026-09-29 231755" src="https://github.com/user-attachments/assets/f6f6a548-6129-49a7-96c2-1d3a48cbd3c1" />

*Upload zone + voice record button + real-time pipeline status*

---

## 🤔 Why This Project Exists

Most RAG demos either skip voice (a PDF chat box) or skip retrieval (a voice chatbot). This project combines the complete pipeline — speak a question, retrieve the relevant document passages, generate an answer, hear it spoken back — and does it entirely on your local machine. That design choice isn't arbitrary: the most valuable enterprise use cases for document AI involve data that cannot leave the building. HR policy Q&A, legal document review, internal knowledge bases, medical records — these all require on-premise inference. This project is built around that constraint from the start, demonstrating that the full voice-to-answer pipeline is achievable without a single external API call after initial setup.

---

## 🏗 Architecture

```
                 ┌──────────────────────────────────────────────────────┐
                 │                  VOICERAG PIPELINE                   │
                 └──────────────────────────────────────────────────────┘

 ┌─────────────┐
 │   BROWSER   │
 │             │  User holds button → MediaRecorder captures audio
 │  🎤 mic     │──────────────────────────────────────────────────────┐
 └─────────────┘              WAV audio blob (POST)                   │
                                                                      ▼
                                                         ┌────────────────────┐
                                                         │  POST /transcribe  │
                                                         │                    │
                                                         │  Whisper base.en   │
                                                         │  runs on CPU       │
                                                         │  ~1s for 5s clip   │
                                                         └──────────┬─────────┘
                                                                    │ transcript text
 ┌─────────────┐                                                     │
 │   BROWSER   │◄────────────────────────────────────────────────────┘
 │             │  transcript shown → auto-sent to /query
 │  "What is…" │──────────────────────────────────────────────────────┐
 └─────────────┘              {question: "..."}  (POST)               │
                                                                      ▼
                                                         ┌────────────────────┐
                                                         │   POST /query      │
                                                         │                    │
                                                         │  ① Embed question  │
                                                         │  all-MiniLM-L6-v2  │
                                                         │  → 384-dim vector  │
                                                         │         │          │
                                                         │  ② Similarity search
                                                         │  ChromaDB cosine   │
                                                         │  → top 4 chunks    │
                                                         │         │          │
                                                         │  ③ Prompt assembly │
                                                         │  Context + Question│
                                                         │         │          │
                                                         │  ④ LLM inference   │
                                                         │  Ollama            │
                                                         │  llama3.2:3b       │
                                                         │  temp = 0.1        │
                                                         └──────────┬─────────┘
                                                                    │ {answer, sources}
 ┌─────────────┐                                                     │
 │   BROWSER   │◄────────────────────────────────────────────────────┘
 │             │
 │  Web Speech │  speaks answer aloud  →  👤 User hears the response
 │     API     │
 └─────────────┘
```

---

## 🛠 Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Frontend** | Next.js 14, TypeScript, Tailwind CSS | Type-safe UI, App Router, zero-config styling |
| **Backend** | FastAPI (Python) | Async-native, OpenAPI docs auto-generated |
| **Speech-to-Text** | OpenAI Whisper base.en (local) | Open-source, CPU-capable, no API key |
| **Embeddings** | sentence-transformers `all-MiniLM-L6-v2` | 80MB, semantic similarity without a GPU |
| **Vector Store** | ChromaDB | In-process, persistent to disk, no server needed |
| **LLM Inference** | Ollama + `llama3.2:3b` | OpenAI-compatible API, runs on 4GB RAM |
| **Text-to-Speech** | Web Speech API (browser built-in) | Zero setup, zero cost, built into Chrome/Edge |
| **HTTP Client** | httpx (async) | Native async for FastAPI, timeout handling |

---

## ✨ Features

- 🎤 **Hold-to-Talk** — MediaRecorder captures audio while button is held, releases to send
- 🔊 **Spoken Answers** — Web Speech API reads the answer aloud after generation
- 📄 **PDF Ingestion** — drag-and-drop or click to upload; PyMuPDF extracts full text
- 🔍 **Semantic Retrieval** — embedding-based search finds relevant chunks, not keyword matches
- 📍 **Source Citations** — collapsible panel shows the exact document passages used to generate the answer
- 🔄 **Real-time Pipeline Status** — UI reflects each stage: recording → transcribing → retrieving → speaking
- 🏠 **Fully Local** — after setup, zero network requests; all inference on your machine
- ⚡ **FastAPI Swagger UI** — auto-generated `/docs` for testing every endpoint without a frontend

---

## 🔬 Technical Deep-Dive

### RAG Implementation

RAG (Retrieval-Augmented Generation) solves a fundamental constraint: LLMs have a fixed context window. `llama3.2:3b` handles roughly 8,000 words at once; a 30-page PDF has ~15,000. Even within window limits, models lose precision when buried in irrelevant text.

The solution: don't give the model the whole document. Find the relevant paragraphs first, give only those to the model.

**Three-stage pipeline:**

```
Ingestion (once per PDF):
  PDF text → chunk → embed each chunk → store (text, vector) in ChromaDB

Retrieval (per query):
  question → embed → cosine similarity search → top 4 chunks returned

Generation:
  "Answer only using this context: [chunks]. Question: [text]" → LLM → answer
```

### Chunking Strategy

Text is split into ~400-word chunks with **50-word overlap** between consecutive chunks.

Why overlap matters: if a sentence begins at the end of chunk 4 and finishes at the start of chunk 5, hard-boundary splitting means neither chunk fully represents that sentence. A query about it would retrieve neither chunk with high confidence. With 50-word overlap, that sentence appears whole in both chunks — it's always findable.

Word-based splitting (not character-based) preserves word integrity. A character split at position 2000 might land mid-word; a word split never does.

### Embedding Model vs LLM — Two Different Jobs

These are commonly confused. They are doing fundamentally different things:

| | `all-MiniLM-L6-v2` | `llama3.2:3b` |
|---|---|---|
| **Job** | Comparator | Generator |
| **Input** | Text chunk or question | Full prompt with context |
| **Output** | 384-dimensional vector | Natural language text |
| **Sees the PDF?** | All chunks, at ingestion | Never — only retrieved passages |
| **Why separate?** | Optimized for similarity | Optimized for language generation |

The embedding model converts meaning to geometry: semantically similar texts land near each other in 384-dimensional space. "The pricing model is subscription-based" and "Users pay monthly" end up geometrically close — even sharing zero words. This is how the retrieval finds relevant chunks without keyword matching.

### Temperature = 0.1 for RAG

Temperature controls randomness in token selection. At 1.0, the model is creative. At 0.1, it's conservative — it picks the most probable next token rather than sampling from the distribution.

In RAG, conservative is correct. You want the model to paraphrase the retrieved context faithfully, not embellish it with confident-sounding details that aren't in the source. When the context doesn't contain the answer, temperature 0.1 makes the model more likely to say "I couldn't find that in the document" rather than generate a plausible-sounding hallucination.

---

## 🏠 Why Local Inference?

Three reasons, in order of importance:

**1. Data privacy by design.** When a company uploads internal documents to a cloud AI service, those documents touch the provider's servers. With on-premise inference, they never leave the machine. This is not a preference — it's a requirement in healthcare, legal, finance, and government contexts.

**2. Architectural insight, not a cost-saving trick.** Ollama deliberately mimics the OpenAI API format. The request your code sends to `http://localhost:11434/v1/chat/completions` is byte-for-byte identical to one sent to `https://api.openai.com/v1/chat/completions`. Switching from local to cloud inference is a one-URL change. The application logic is completely decoupled from the inference provider.

**3. Real-world relevance.** Companies like Sarvam AI, Gnani.ai, and Vaani AI build on-premise voice AI systems for enterprises that cannot use cloud APIs. This project demonstrates the same architecture at prototype scale.

---

## 🚀 Getting Started

### Prerequisites

- Python 3.11
- Node.js 18+
- Git
- 6GB free RAM (4GB for the model + 2GB headroom)
- 5GB free disk space (model + dependencies)

### Install Ollama and pull the model (all platforms)

```bash
# 1. Download Ollama from https://ollama.com/download
# 2. Pull the LLM (runs in background — ~2GB download)
ollama pull llama3.2:3b

# Verify it worked
ollama list
```

---

### Windows

```powershell
# Clone the repo
git clone https://github.com/vaiebhavvats16/voice-rag-assistant.git
cd voice-rag-assistant

# Backend setup
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt

# Copy environment config
copy .env.example .env

# Start backend (keep this terminal open)
uvicorn main:app --reload --port 8000
```

Open a second terminal:

```powershell
# Frontend setup
cd voice-rag-assistant\frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

### macOS / Linux

```bash
# Clone the repo
git clone https://github.com/vaiebhavvats16/voice-rag-assistant.git
cd voice-rag-assistant

# Backend setup
cd backend
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Copy environment config
cp .env.example .env

# Start backend (keep this terminal open)
uvicorn main:app --reload --port 8000
```

Open a second terminal:

```bash
# Frontend setup
cd voice-rag-assistant/frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

### Environment variables

```env
# backend/.env
OLLAMA_URL=http://localhost:11434
WHISPER_MODEL=base.en
CHROMA_PATH=./chroma_db
```

No API keys required. All values point to local services.

---

### Using the app

1. Upload a PDF using the drag-and-drop zone (any document — research paper, report, article)
2. Wait for "Document ready" (green checkmark) — this embeds and indexes the full document
3. Hold the mic button and ask a question about the document's content
4. Release — watch the pipeline states cycle in real time
5. Hear the answer spoken aloud; expand "Sources" to see which passages were retrieved

---

## 📁 Project Structure

```
voice-rag-assistant/
├── backend/
│   ├── main.py               # FastAPI app — /health, /ingest, /transcribe, /query
│   ├── requirements.txt      # Pinned Python dependencies
│   ├── .env.example          # Environment variable template
│   └── chroma_db/            # Auto-created — ChromaDB vector store (persists to disk)
│
└── frontend/
    └── src/
        ├── app/
        │   └── page.tsx          # Root page — renders VoiceRAG component
        └── components/
            └── VoiceRAG.tsx      # Entire UI + voice pipeline state machine
```

**Key files:**

| File | What it does |
|---|---|
| `backend/main.py` | All four endpoints. Models loaded once at startup. |
| `frontend/src/components/VoiceRAG.tsx` | 7-state state machine, MediaRecorder, Whisper calls, RAG calls, TTS |

---

## 🔮 What I'd Add Next

**1. Streaming responses**
Currently the app waits for the full LLM response before speaking. With Ollama's streaming API and Server-Sent Events, tokens can be piped to the frontend and spoken sentence-by-sentence as they generate. This changes the perceived latency from "wait 4 seconds then hear answer" to "hear the answer starting in under a second." It's a meaningful UX shift and a non-trivial engineering change.

**2. Multi-document support with scoped retrieval**
The current ChromaDB collection holds one document's chunks. With a `doc_id` filter on every query, users could upload 20 documents and ask "compare how Document A and Document B handle this topic" — each query only searches within the specified document's chunks. The schema change is small; the product value is significant.

**3. Retrieval evaluation pipeline**
There's no way to currently measure whether the retrieval is working well. Adding an evaluation script that generates question-answer pairs from a known document (using the LLM), then measures whether the correct chunks were retrieved for each question, would produce a retrieval accuracy score. Few portfolio projects include this — it's the difference between "I built RAG" and "I measured whether my RAG works."

---

## 🧠 Skills Demonstrated

| Technology | Skill |
|---|---|
| FastAPI + Python async | Backend API design, async request handling, file upload processing |
| Whisper (local STT) | ML model integration, audio processing, temp file lifecycle management |
| sentence-transformers | Embedding model usage, vector representation of semantic meaning |
| ChromaDB | Vector database operations, similarity search, persistent storage |
| Ollama (local LLM) | Local model serving, OpenAI-compatible API integration, prompt engineering |
| RAG pipeline | End-to-end retrieval-augmented generation, chunking strategy, context assembly |
| Next.js 14 + TypeScript | App Router, client components, typed state management |
| MediaRecorder API | Browser audio capture, blob handling, stream lifecycle |
| Web Speech API | Browser TTS integration, utterance event handling |
| State machine design | Multi-state UI management, transition logic, error boundaries |

---

## 📬 Contact

Built by **Vaiebhav Vats**

- 💻 Portfolio: [portfolio-website-vdev.vercel.app](https://portfolio-website-vdev.vercel.app/)
- 🔗 LinkedIn: [linkedin.com/in/vaiebhav-vats](https://linkedin.com/in/vaiebhav-vats/)
- 💻 GitHub: [github.com/vaiebhavvats16](https://github.com/vaiebhavvats16)
- 📧 Email: vaiebhavvats@gmail.com

---

> ⭐ If this project was useful or interesting to you, a star on the repo goes a long way — it helps other developers working on local AI find it.
