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

const QUICK_QUESTIONS = [
  "Summarize this document",
  "What are the key points?",
  "What does it conclude?",
];

function getStatusMessage(state: AppState, hasPdf: boolean): string {
  switch (state) {
    case "idle":
      return hasPdf ? "Hold the mic and ask a question" : "Upload a PDF to get started";
    case "uploading":
      return "Reading your document";
    case "recording":
      return "Listening — release to send";
    case "transcribing":
      return "Turning speech into text";
    case "retrieving":
      return "Searching the document";
    case "speaking":
      return "Speaking the answer";
    case "error":
      return "";
    default:
      return "";
  }
}

function MicIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
    </svg>
  );
}

function DocIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
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
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  // --- Refs: internal bookkeeping, no re-render needed ---
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Derived state — computed on every render, never stored
  const isBusy = ["uploading", "recording", "transcribing", "retrieving"].includes(appState);
  const isTalkButtonDisabled =
    !hasPdf || !["idle", "speaking", "error"].includes(appState);

  // --- PDF upload logic ---
  const handlePdfUpload = async (file: File) => {
    if (file.type !== "application/pdf") {
      setAppState("error");
      setErrorMessage("That file isn't a PDF. Choose a .pdf and try again.");
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
      setFileName(file.name);
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
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handlePdfUpload(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handlePdfUpload(file);
    e.target.value = ""; // allows re-selecting the same file
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
      setErrorMessage("Microphone access denied. Allow microphone access and try again.");
    }
  };

  const handleRecordStop = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      // Stop all audio tracks to release the microphone
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
    }
  };

  // Shared by both input modes: voice transcript and text chips
  const runQuery = async (question: string) => {
    try {
      setAppState("retrieving");
      const queryRes = await axios.post("http://localhost:8000/query", { question });
      const answerText: string = queryRes.data.answer;
      const sourcesData: string[] = queryRes.data.sources || [];
      setAnswer(answerText);
      setSources(sourcesData);
      setShowSources(false);

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

      // Step 3 + 4: Query RAG, then speak
      await runQuery(transcriptText);
    } catch (err) {
      setAppState("error");
      setErrorMessage(
        axios.isAxiosError(err)
          ? `Request failed: ${err.message}`
          : "Something went wrong. Please try again."
      );
    }
  };

  const handleQuickQuestion = (question: string) => {
    if (!hasPdf || isBusy) return;
    window.speechSynthesis.cancel();
    setTranscript(question);
    runQuery(question);
  };

  const speakAnswer = (text: string) => {
    window.speechSynthesis.cancel(); // stop any previous speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.onend = () => setAppState("idle");
    window.speechSynthesis.speak(utterance);
  };

  const handleStartOver = () => {
    window.speechSynthesis.cancel();
    setTranscript("");
    setAnswer("");
    setSources([]);
    setShowSources(false);
    setErrorMessage("");
    setAppState("idle");
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleFileDrop}
      className="relative min-h-screen overflow-hidden bg-black text-white antialiased"
    >
      {/* Ambient glow at the base of the page */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[48vh] overflow-hidden">
        <div
          className="absolute inset-x-[-10%] bottom-[-14%] h-full opacity-60 blur-[70px]"
          style={{
            background:
              "repeating-linear-gradient(101deg, #0a0a1f 0px, #3730a3 16px, #1e1b4b 34px, #060612 58px)",
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/75 to-transparent" />
      </div>

      {/* Drag overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-4 z-30 flex items-center justify-center rounded-3xl border border-dashed border-white/40 bg-black/70 backdrop-blur-sm">
          <p className="text-lg text-white/80">Drop your PDF to load it</p>
        </div>
      )}

      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center px-6 pb-16 pt-20 sm:pt-28">
        {/* Hero */}
        <h1 className="text-center text-[2.75rem] font-medium leading-[0.98] tracking-[-0.045em] sm:text-6xl">
          VoiceRAG AI
        </h1>
        <p className="mt-5 max-w-md text-center text-[15px] leading-relaxed text-neutral-400">
          Upload a PDF, hold the mic, and hear the answer read back.
          Speech, search, and generation all run on your machine.
        </p>

        {/* Pill actions */}
        <div className="mt-8 flex items-center gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={appState === "uploading"}
            className="rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black transition hover:bg-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:opacity-60"
          >
            {appState === "uploading"
              ? "Reading PDF…"
              : hasPdf
              ? "Upload another PDF"
              : "Upload a PDF"}
          </button>
          <button
            onClick={handleStartOver}
            disabled={!answer && !transcript && appState !== "error"}
            className="rounded-full border border-white/15 bg-white/[0.04] px-6 py-2.5 text-sm font-medium text-white transition hover:border-white/30 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40 disabled:hover:border-white/15 disabled:hover:bg-white/[0.04]"
          >
            Start over
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* Console panel */}
        <section className="mt-14 w-full rounded-[22px] border border-white/10 bg-[#0c0c10]/90 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl">
          {/* Conversation area */}
          <div className="flex min-h-[210px] flex-col justify-start gap-4 px-6 pt-7 sm:px-8">
            {answer === "" ? (
              <p className="text-[17px] leading-relaxed text-neutral-200">
                {hasPdf
                  ? "Your document is loaded. Ask anything about it."
                  : "No document yet. Upload a PDF to begin."}
              </p>
            ) : (
              <div className="space-y-4">
                <p className="text-[15px] leading-relaxed text-neutral-500">{transcript}</p>
                <p className="text-[17px] leading-relaxed text-neutral-100">{answer}</p>

                {sources.length > 0 && (
                  <div>
                    <button
                      onClick={() => setShowSources(!showSources)}
                      className="text-[13px] text-neutral-500 underline-offset-4 transition hover:text-neutral-300 hover:underline focus:outline-none focus-visible:text-white"
                    >
                      {showSources ? "Hide passages used" : `Show ${sources.length} passages used`}
                    </button>
                    {showSources && (
                      <div className="mt-3 space-y-2">
                        {sources.map((source, i) => (
                          <p
                            key={i}
                            className="line-clamp-3 rounded-lg border border-white/5 bg-white/[0.03] p-3 text-[13px] leading-relaxed text-neutral-500"
                          >
                            {source}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Status line */}
            <div className="mt-auto pb-1 text-[13px]">
              {appState === "error" ? (
                <span className="text-red-400">{errorMessage}</span>
              ) : (
                <span className="flex items-center gap-2 text-neutral-500">
                  {appState === "recording" && (
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
                  )}
                  {getStatusMessage(appState, hasPdf)}
                </span>
              )}
            </div>
          </div>

          {/* Control bar */}
          <div className="flex items-center gap-2.5 overflow-x-auto px-6 py-5 sm:px-8">
            <span
              title={fileName || "No document loaded"}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition ${
                hasPdf
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-white/10 bg-white/[0.04] text-neutral-600"
              }`}
            >
              <DocIcon className="h-4 w-4" />
            </span>

            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => handleQuickQuestion(q)}
                disabled={!hasPdf || isBusy}
                className="shrink-0 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] text-neutral-300 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-35 disabled:hover:border-white/10 disabled:hover:bg-white/[0.04] disabled:hover:text-neutral-300"
              >
                {q}
              </button>
            ))}

            <button
              aria-label="Hold to ask a question"
              disabled={isTalkButtonDisabled}
              onMouseDown={() => handleRecordStart()}
              onMouseUp={() => handleRecordStop()}
              onMouseLeave={() => handleRecordStop()}
              onTouchStart={(e) => {
                e.preventDefault();
                handleRecordStart();
              }}
              onTouchEnd={() => handleRecordStop()}
              className={`ml-auto flex h-12 w-12 shrink-0 select-none items-center justify-center rounded-full transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0c10] ${
                appState === "recording"
                  ? "scale-105 bg-red-500 text-white shadow-[0_0_0_6px_rgba(239,68,68,0.18)]"
                  : "bg-white text-black hover:bg-neutral-200"
              } ${isTalkButtonDisabled ? "cursor-not-allowed opacity-40 hover:bg-white" : ""}`}
            >
              <MicIcon className="h-5 w-5" />
            </button>
          </div>
        </section>

        <p className="mt-6 text-center text-[12px] text-neutral-600">
          Hold the mic while you speak, then release
        </p>
      </main>
    </div>
  );
}





















// "use client";

// import { useState, useRef } from "react";
// import axios from "axios";

// type AppState =
//   | "idle"
//   | "uploading"
//   | "recording"
//   | "transcribing"
//   | "retrieving"
//   | "speaking"
//   | "error";

// function getStatusMessage(state: AppState, hasPdf: boolean): string {
//   switch (state) {
//     case "idle":
//       return hasPdf ? "Hold the button and ask a question" : "Upload a PDF to get started";
//     case "uploading":
//       return "Processing document...";
//     case "recording":
//       return "Listening... release to send";
//     case "transcribing":
//       return "Transcribing your question...";
//     case "retrieving":
//       return "Searching the document...";
//     case "speaking":
//       return "Speaking...";
//     case "error":
//       return "";
//     default:
//       return "";
//   }
// }

// export default function VoiceRAG() {
//   // --- State: drives what's rendered on screen ---
//   const [appState, setAppState] = useState<AppState>("idle");
//   const [transcript, setTranscript] = useState("");
//   const [answer, setAnswer] = useState("");
//   const [sources, setSources] = useState<string[]>([]);
//   const [errorMessage, setErrorMessage] = useState("");
//   const [hasPdf, setHasPdf] = useState(false);
//   const [showSources, setShowSources] = useState(false);

//   // --- Refs: internal bookkeeping, no re-render needed ---
//   const mediaRecorderRef = useRef<MediaRecorder | null>(null);
//   const audioChunksRef = useRef<Blob[]>([]);
//   const fileInputRef = useRef<HTMLInputElement | null>(null);

//   // --- PDF upload logic ---
//   const handlePdfUpload = async (file: File) => {
//     if (file.type !== "application/pdf") {
//       setAppState("error");
//       setErrorMessage("Please upload a PDF file");
//       return;
//     }

//     setAppState("uploading");
//     setErrorMessage("");

//     const formData = new FormData();
//     formData.append("file", file);

//     try {
//       await axios.post("http://localhost:8000/ingest", formData, {
//         headers: { "Content-Type": "multipart/form-data" },
//       });
//       setHasPdf(true);
//       setAppState("idle");
//     } catch (err) {
//       setAppState("error");
//       setErrorMessage(
//         axios.isAxiosError(err) ? err.message : "Failed to process PDF"
//       );
//     }
//   };

//   const handleFileDrop = (e: React.DragEvent) => {
//     e.preventDefault();
//     const file = e.dataTransfer.files?.[0];
//     if (file) handlePdfUpload(file);
//   };

//   const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
//     const file = e.target.files?.[0];
//     if (file) handlePdfUpload(file);
//   };

//   // --- Voice recording + query pipeline ---
//   const handleRecordStart = async () => {
//     try {
//       const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
//       const recorder = new MediaRecorder(stream);
//       audioChunksRef.current = [];

//       recorder.ondataavailable = (e: BlobEvent) => {
//         if (e.data.size > 0) audioChunksRef.current.push(e.data);
//       };

//       recorder.onstop = async () => {
//         await processAudio();
//       };

//       mediaRecorderRef.current = recorder;
//       recorder.start(250); // fires ondataavailable every 250ms
//       setAppState("recording");
//     } catch (err) {
//       setAppState("error");
//       setErrorMessage("Microphone access denied. Please allow microphone access and try again.");
//     }
//   };

//   const handleRecordStop = () => {
//     if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
//       mediaRecorderRef.current.stop();
//       // Stop all audio tracks to release the microphone
//       mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
//     }
//   };

//   const processAudio = async () => {
//     try {
//       // Step 1: Create audio blob from chunks
//       const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" });

//       // Step 2: Transcribe
//       setAppState("transcribing");
//       const formData = new FormData();
//       formData.append("file", audioBlob, "recording.wav");
//       const transcribeRes = await axios.post("http://localhost:8000/transcribe", formData);
//       const transcriptText: string = transcribeRes.data.transcript;
//       setTranscript(transcriptText);

//       // Step 3: Query RAG
//       setAppState("retrieving");
//       const queryRes = await axios.post("http://localhost:8000/query", {
//         question: transcriptText,
//       });
//       const answerText: string = queryRes.data.answer;
//       const sourcesData: string[] = queryRes.data.sources || [];
//       setAnswer(answerText);
//       setSources(sourcesData);

//       // Step 4: Speak the answer
//       setAppState("speaking");
//       speakAnswer(answerText);
//     } catch (err) {
//       setAppState("error");
//       setErrorMessage(
//         axios.isAxiosError(err)
//           ? `Request failed: ${err.message}`
//           : "Something went wrong. Please try again."
//       );
//     }
//   };

//   const speakAnswer = (text: string) => {
//     window.speechSynthesis.cancel(); // stop any previous speech
//     const utterance = new SpeechSynthesisUtterance(text);
//     utterance.rate = 0.95;
//     utterance.pitch = 1.0;
//     utterance.onend = () => setAppState("idle");
//     window.speechSynthesis.speak(utterance);
//   };

//   const isTalkButtonDisabled =
//     !hasPdf || !["idle", "speaking", "error"].includes(appState);

//   return (
//     <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center p-8">
//       <div className="max-w-2xl w-full mx-auto">
//         {/* Section 1 — Header */}
//         <h1 className="text-3xl font-bold text-center">Voice Document Q&A</h1>
//         <p className="text-gray-400 text-center mt-2">
//           Upload a PDF, then hold the button and ask a question
//         </p>

//         {/* Section 2 — PDF Upload Zone */}
//         <div
//           onClick={() => fileInputRef.current?.click()}
//           onDragOver={(e) => e.preventDefault()}
//           onDrop={handleFileDrop}
//           className={`mt-8 border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
//             hasPdf
//               ? "border-green-500 bg-green-900/20"
//               : "border-gray-600 hover:border-blue-500"
//           }`}
//         >
//           {hasPdf ? (
//             <span className="text-green-500">✅ Document ready</span>
//           ) : (
//             <span className="text-gray-400">📄 Drop PDF here or click to upload</span>
//           )}
//           <input
//             ref={fileInputRef}
//             type="file"
//             accept=".pdf"
//             onChange={handleFileSelect}
//             className="hidden"
//           />
//         </div>

//         {/* Section 3 — Status Bar */}
//         <div className="mt-6 text-center">
//           {appState === "recording" && (
//             <span>
//               <span className="animate-pulse inline-block w-3 h-3 rounded-full bg-red-500 mr-2" />
//               <span className="text-gray-300">{getStatusMessage(appState, hasPdf)}</span>
//             </span>
//           )}
//           {appState === "error" && (
//             <span className="text-red-400">{errorMessage}</span>
//           )}
//           {appState !== "recording" && appState !== "error" && (
//             <span className="text-gray-300">{getStatusMessage(appState, hasPdf)}</span>
//           )}
//         </div>

//         {/* Section 4 — Talk Button */}
//         <div className="mt-8 flex justify-center">
//           <button
//             disabled={isTalkButtonDisabled}
//             onMouseDown={() => handleRecordStart()}
//             onMouseUp={() => handleRecordStop()}
//             onMouseLeave={() => handleRecordStop()}
//             onTouchStart={(e) => {
//               e.preventDefault();
//               handleRecordStart();
//             }}
//             onTouchEnd={() => handleRecordStop()}
//             className={`w-24 h-24 rounded-full text-4xl transition-all duration-200 ${
//               appState === "recording"
//                 ? "bg-red-600 animate-pulse"
//                 : "bg-blue-600 hover:bg-blue-700 text-white"
//             } ${isTalkButtonDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
//           >
//             🎤
//           </button>
//         </div>

//         {/* Section 5 — Answer Display */}
//         {answer !== "" && (
//           <div className="mt-8">
//             <p className="text-gray-300">
//               <span className="font-semibold">You asked:</span>{" "}
//               <span className="italic">{transcript}</span>
//             </p>
//             <p className="text-white font-medium mt-2">
//               <span className="font-semibold">Answer:</span> {answer}
//             </p>

//             <button
//               onClick={() => setShowSources(!showSources)}
//               className="mt-4 text-sm text-blue-400 underline"
//             >
//               Sources
//             </button>

//             {showSources &&
//               sources.map((source, i) => (
//                 <div
//                   key={i}
//                   className="bg-gray-800 rounded p-3 mt-2 text-sm text-gray-400 line-clamp-3"
//                 >
//                   {source}
//                 </div>
//               ))}
//           </div>
//         )}
//       </div>
//     </div>
//   );
// }




