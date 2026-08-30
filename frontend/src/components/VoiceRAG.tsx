"use client";

import { useState, useRef } from "react";
import axios from "axios";

type AppState =
  | "idle"
  | "uploading"
  | "recording"
  | "transcribing"
  | "retrieving"
  | "speaking"
  | "error";

function getStatusMessage(state: AppState, hasPdf: boolean): string {
  switch (state) {
    case "idle":
      return hasPdf ? "Hold the button and ask a question" : "Upload a PDF to get started";
    case "uploading":
      return "Processing document...";
    case "recording":
      return "Listening... release to send";
    case "transcribing":
      return "Transcribing your question...";
    case "retrieving":
      return "Searching the document...";
    case "speaking":
      return "Speaking...";
    case "error":
      return "";
    default:
      return "";
  }
}

export default function VoiceRAG() {
  // --- State: drives what's rendered on screen ---
  const [appState, setAppState] = useState<AppState>("idle");
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [hasPdf, setHasPdf] = useState(false);
  const [showSources, setShowSources] = useState(false);

  // --- Refs: internal bookkeeping, no re-render needed ---
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // --- PDF upload logic ---
  const handlePdfUpload = async (file: File) => {
    if (file.type !== "application/pdf") {
      setAppState("error");
      setErrorMessage("Please upload a PDF file");
      return;
    }

    setAppState("uploading");
    setErrorMessage("");

    const formData = new FormData();
    formData.append("file", file);

    try {
      await axios.post("http://localhost:8000/ingest", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setHasPdf(true);
      setAppState("idle");
    } catch (err) {
      setAppState("error");
      setErrorMessage(
        axios.isAxiosError(err) ? err.message : "Failed to process PDF"
      );
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handlePdfUpload(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handlePdfUpload(file);
  };

  // --- Voice recording + query pipeline ---
  const handleRecordStart = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        await processAudio();
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250); // fires ondataavailable every 250ms
      setAppState("recording");
    } catch (err) {
      setAppState("error");
      setErrorMessage("Microphone access denied. Please allow microphone access and try again.");
    }
  };

  const handleRecordStop = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      // Stop all audio tracks to release the microphone
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
    }
  };

  const processAudio = async () => {
    try {
      // Step 1: Create audio blob from chunks
      const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" });

      // Step 2: Transcribe
      setAppState("transcribing");
      const formData = new FormData();
      formData.append("file", audioBlob, "recording.wav");
      const transcribeRes = await axios.post("http://localhost:8000/transcribe", formData);
      const transcriptText: string = transcribeRes.data.transcript;
      setTranscript(transcriptText);

      // Step 3: Query RAG
      setAppState("retrieving");
      const queryRes = await axios.post("http://localhost:8000/query", {
        question: transcriptText,
      });
      const answerText: string = queryRes.data.answer;
      const sourcesData: string[] = queryRes.data.sources || [];
      setAnswer(answerText);
      setSources(sourcesData);

      // Step 4: Speak the answer
      setAppState("speaking");
      speakAnswer(answerText);
    } catch (err) {
      setAppState("error");
      setErrorMessage(
        axios.isAxiosError(err)
          ? `Request failed: ${err.message}`
          : "Something went wrong. Please try again."
      );
    }
  };

  const speakAnswer = (text: string) => {
    window.speechSynthesis.cancel(); // stop any previous speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.onend = () => setAppState("idle");
    window.speechSynthesis.speak(utterance);
  };

  const isTalkButtonDisabled =
    !hasPdf || !["idle", "speaking", "error"].includes(appState);

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center p-8">
      <div className="max-w-2xl w-full mx-auto">
        {/* Section 1 — Header */}
        <h1 className="text-3xl font-bold text-center">Voice Document Q&A</h1>
        <p className="text-gray-400 text-center mt-2">
          Upload a PDF, then hold the button and ask a question
        </p>

        {/* Section 2 — PDF Upload Zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleFileDrop}
          className={`mt-8 border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            hasPdf
              ? "border-green-500 bg-green-900/20"
              : "border-gray-600 hover:border-blue-500"
          }`}
        >
          {hasPdf ? (
            <span className="text-green-500">✅ Document ready</span>
          ) : (
            <span className="text-gray-400">📄 Drop PDF here or click to upload</span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* Section 3 — Status Bar */}
        <div className="mt-6 text-center">
          {appState === "recording" && (
            <span>
              <span className="animate-pulse inline-block w-3 h-3 rounded-full bg-red-500 mr-2" />
              <span className="text-gray-300">{getStatusMessage(appState, hasPdf)}</span>
            </span>
          )}
          {appState === "error" && (
            <span className="text-red-400">{errorMessage}</span>
          )}
          {appState !== "recording" && appState !== "error" && (
            <span className="text-gray-300">{getStatusMessage(appState, hasPdf)}</span>
          )}
        </div>

        {/* Section 4 — Talk Button */}
        <div className="mt-8 flex justify-center">
          <button
            disabled={isTalkButtonDisabled}
            onMouseDown={() => handleRecordStart()}
            onMouseUp={() => handleRecordStop()}
            onMouseLeave={() => handleRecordStop()}
            onTouchStart={(e) => {
              e.preventDefault();
              handleRecordStart();
            }}
            onTouchEnd={() => handleRecordStop()}
            className={`w-24 h-24 rounded-full text-4xl transition-all duration-200 ${
              appState === "recording"
                ? "bg-red-600 animate-pulse"
                : "bg-blue-600 hover:bg-blue-700 text-white"
            } ${isTalkButtonDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            🎤
          </button>
        </div>

        {/* Section 5 — Answer Display */}
        {answer !== "" && (
          <div className="mt-8">
            <p className="text-gray-300">
              <span className="font-semibold">You asked:</span>{" "}
              <span className="italic">{transcript}</span>
            </p>
            <p className="text-white font-medium mt-2">
              <span className="font-semibold">Answer:</span> {answer}
            </p>

            <button
              onClick={() => setShowSources(!showSources)}
              className="mt-4 text-sm text-blue-400 underline"
            >
              Sources
            </button>

            {showSources &&
              sources.map((source, i) => (
                <div
                  key={i}
                  className="bg-gray-800 rounded p-3 mt-2 text-sm text-gray-400 line-clamp-3"
                >
                  {source}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}




