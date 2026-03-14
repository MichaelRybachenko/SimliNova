import React, { useEffect, useRef, useState, useCallback } from "react";
import { LogLevel, SimliClient } from "simli-client";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

// This represents the legacy format - leaving comment but removing global
// let mockVault: any = {};

const bedrockClient = new BedrockRuntimeClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID || "",
    secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY || "",
  }
});

async function analyzeTaxFiles(files: File[]) {
  const content: any[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const buffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);

    if (file.type === "application/pdf") {
      content.push({
        document: {
          name: `doc_${i}`,
          format: "pdf",
          source: { bytes: uint8Array }
        }
      });
    } else if (file.type.startsWith("image/")) {
      let format = "jpeg"; // default
      if (file.type === "image/png") format = "png";
      else if (file.type === "image/webp") format = "webp";
      else if (file.type === "image/gif") format = "gif";
      else if (file.type === "image/jpeg") format = "jpeg";

      content.push({
        image: {
          format: format,
          source: { bytes: uint8Array }
        }
      });
    }
  }

  const extractionPrompt = `
    Analyze this document (or set of images) and return a JSON object with these EXACT keys:
    {
      "identity": {
        "full_name": "string",
        "ssn_last_4": "string"
      },
      "metadata": {
        "tax_year": "YYYY",
        "form_type": "1099-B | 1099-DIV | W-2 | etc"
      },
      "data_fields": {
        "key": "value" // Extract EVERY field found on the form
      },
      "alisa_speech": "A short 1-sentence confirmation of who this belongs to and what it is."
    }
    Strictly return JSON. If the year or name is missing, mark as "UNKNOWN".
  `;

  content.push({ text: extractionPrompt });

  let response;
  try {
    const command = new ConverseCommand({
      modelId: "us.amazon.nova-lite-v1:0", // Cross-region Nova Lite
      messages: [{ role: "user", content }]
    });
    response = await bedrockClient.send(command);
  } catch (err: any) {
    console.warn("Cross-region Nova Lite failed, falling back to base ID amazon.nova-lite-v1:0", err);
    try {
      const fallbackCommand = new ConverseCommand({
        modelId: "amazon.nova-lite-v1:0", // Fallback to base Nova Lite
        messages: [{ role: "user", content }]
      });
      response = await bedrockClient.send(fallbackCommand);
    } catch(fallbackErr) {
       throw fallbackErr; // If this fails, let the error propagate to the UI
    }
  }

  const text = response.output?.message?.content?.[0]?.text || "";
  
  // Try to cleanly extract JSON if wrapped in markdown blocks
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  return text;
}

// No longer using `routeDocumentMock` since we manage state in React now, but keeping for reference or you can completely remove it down the line.

export interface TaxDocument {
  id: string;
  owner: string;
  taxYear: string;
  formName: string;
  ordinalNumber: number;
  dataFields: string; // JSON string for easy editing
  isReviewing: boolean; // Flag to indicate if user needs to confirm missing info
}

const SimliLiveNova: React.FC = () => {
  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliClientRef = useRef<SimliClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const isInitializing = useRef(false); // Ref to prevent double-initialization in Strict Mode
  const playbackContextRef = useRef<AudioContext | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const dominantColorRef = useRef<string | null>(null);
  
  // --- State ---
  const [isSimliReady, setIsSimliReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInteracted, setHasInteracted] = useState(false); // Controls initialization
  const [chatHistory, setChatHistory] = useState<
    {
      role: "user" | "assistant";
      content: string;
      id?: string;
      image?: string;
      isImageLoading?: boolean;
    }[]
  >([]);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [inputText, setInputText] = useState("");
  const [showTranscript, setShowTranscript] = useState(true);
  const [showThinking, setShowThinking] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  // --- Scanner States ---
  const [scanFiles, setScanFiles] = useState<File[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null); // Kept for raw errors
  const [vaultDocuments, setVaultDocuments] = useState<TaxDocument[]>([]);
  const vaultDocumentsRef = useRef<TaxDocument[]>([]); // To access in WebSocket closure

  // --- Constants ---
  const SIMLI_API_KEY = import.meta.env.VITE_SIMLI_API_KEY;
  const SIMLI_FACE_ID = import.meta.env.VITE_SIMLI_FACE_ID;

  // --- Helpers ---
  const handleDownload = (content: string, index: number) => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-history-${index}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const base64ToUint8Array = (base64: string) => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  };

  const arrayBufferToBase64 = (buffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;

    // Efficiently build the binary string
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    return window.btoa(binary);
  };

  // Downsample form 24000 (Gemini) to 16000 (Simli)
  const downsampleTo16k = (audioData: Int16Array) => {
    const ratio = 1.5;
    const newLength = Math.round(audioData.length / ratio);
    const result = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const center = Math.floor(i * ratio);
      // Weighted anti-aliasing filter
      if (center > 0 && center < audioData.length - 1) {
        result[i] =
          audioData[center - 1] * 0.25 +
          audioData[center] * 0.5 +
          audioData[center + 1] * 0.25;
      } else {
        result[i] = audioData[center];
      }
    }
    return result;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setScanFiles(Array.from(e.target.files));
    }
  };

  const scanSelectedFiles = async () => {
    if (scanFiles.length === 0) return;
    setIsScanning(true);
    setScanResult(null);
    try {
      const rawResultString = await analyzeTaxFiles(scanFiles);
      const parsed = JSON.parse(rawResultString);
      
      const formName = parsed.metadata?.form_type && parsed.metadata.form_type !== "UNKNOWN" ? parsed.metadata.form_type : "";
      const taxYear = parsed.metadata?.tax_year && parsed.metadata.tax_year !== "UNKNOWN" ? parsed.metadata.tax_year : "";
      const owner = parsed.identity?.full_name && parsed.identity.full_name !== "UNKNOWN" ? parsed.identity.full_name : "";
      
      const ordinal = vaultDocumentsRef.current.filter(d => d.formName === formName && d.taxYear === taxYear && d.owner === owner).length + 1;
      const isMissingInfo = !formName || !taxYear || !owner;
      
      const newDoc: TaxDocument = {
          id: `doc_${Date.now()}`,
          owner,
          taxYear: taxYear.toString(),
          formName,
          ordinalNumber: ordinal,
          dataFields: JSON.stringify(parsed.data_fields || {}, null, 2),
          isReviewing: isMissingInfo
      };

      const updatedVault = [...vaultDocumentsRef.current, newDoc];
      setVaultDocuments(updatedVault);
      vaultDocumentsRef.current = updatedVault;

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        // Send a system prompt routing the data
        const systemMessage = {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                text: `[SYSTEM] Nova Lite Vision just scanned a document. Result: ${rawResultString}. 
                ${isMissingInfo ? "Some fields were missing, so the user might need to fill them in." : "It has been saved to the vault."} 
                Acknowledge this briefly.`,
              },
            ],
          },
        };
        wsRef.current.send(JSON.stringify(systemMessage));
        // Force the assistant to reply
        wsRef.current.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (err: any) {
      console.error("Scan error", err);
      setScanResult({ error: err.name || "Error", message: err.message || JSON.stringify(err) });
    } finally {
      setIsScanning(false);
      setScanFiles([]);
    }
  };

  // --- Initialization ---
  const initialize = async () => {
    // Prevent double-initialization (e.g. React Strict Mode)
    if (isInitializing.current || !videoRef.current || !audioRef.current)
      return;
    isInitializing.current = true;

    setError("");

    try {
      console.log("Initializing Simli...");

      // 1. Get Simli Token (Client-side directly to Simli API)
      const simliConfig = {
        faceId: SIMLI_FACE_ID,
        handleSilence: true,
        maxSessionLength: 3600,
        maxIdleTime: 600,
      };

      const tokenResp = await fetch("https://api.simli.ai/compose/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-simli-api-key": SIMLI_API_KEY,
        },
        body: JSON.stringify(simliConfig),
      });
      if (!tokenResp.ok) throw new Error("Failed to get Simli token");
      const tokenData = await tokenResp.json();

      // 2. Get ICE Servers
      const iceResp = await fetch("https://api.simli.ai/compose/ice", {
        method: "GET",
        headers: { "x-simli-api-key": SIMLI_API_KEY }, // Warning: exposing API Key
      });
      const iceServers = iceResp.ok
        ? await iceResp.json()
        : [{ urls: ["stun:stun.l.google.com:19302"] }];

      // 3. Initialize Simli Client
      const client = new SimliClient(
        tokenData.session_token,
        videoRef.current,
        audioRef.current,
        iceServers,
        LogLevel.ERROR,
        "p2p",
        "websockets",
        "wss://api.simli.ai",
        3000,
      );

      simliClientRef.current = client;

      simliClientRef.current.on("speaking", () => {
        console.log("SPEAKING...");
        setIsSpeaking(true);
      });
      simliClientRef.current.on("silent", () => {
        console.log("SILENT...");
        setIsSpeaking(false);
      });
      simliClientRef.current.on("stop", () =>
        console.log("SimliClient disconnected"),
      );

      await client.start();
      console.log("Simli Client Started");
      setIsSimliReady(true);

      // 4. Connect to Nova Realtime
      connectToNova();
    } catch (e: any) {
      console.error(e);
      setError("Init Error: " + e.message);
    }
  };

  const connectToNova = () => {
    // Port might vary depending on Vite. Let's use relative path.
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Switched back to Sonic model 
    const url = `${scheme}//${window.location.host}/nova-realtime?model=amazon.nova-2-sonic-v1:0`;

    const ws = new WebSocket(url);

    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Nova WebSocket Connected. Waiting for session.created...");
      // Start recording immediately so it's ready
      startAudioRecording();
    };

    ws.onmessage = async (event: MessageEvent) => {
      const response = JSON.parse(event.data);

      if (response.type === "error") {
        console.error(
          "NOVA Websocket Error:",
          JSON.stringify(response.error, null, 2),
        );
      } else if (response.type === "session.created") {
        console.log("Session created. Send session.update...");
        // Initial Setup Message (session.update)
        const sessionUpdate = {
          type: "session.update",
          session: {
            type: "realtime",
            instructions: `
## ROLE
You are Alisa, a futuristic Tax Advisor. Your objective is to provide real-time, 
conversational tax guidance for high-frequency traders and tech professionals.

## VOICE & PERSONALITY
- TONE: Professional, reassuring, and slightly witty. You are a "FinTech 
  Companion," not a cold calculator.
- CADENCE: Speak in short, punchy sentences. Avoid long monologues.
- BREVITY: Keep each response to 2-3 sentences max. This reduces latency 
  and keeps the avatar animation fluid.
- VERBAL FILLERS: Occasionally use "I see," "Got it," or "Let's look at that" 
  to mimic natural human thought-processing time.

## DOMAIN EXPERTISE (STOCKS & OPTIONS)
- Specialize in capital gains (short vs. long term), wash-sale rules, and 
  tax-loss harvesting.
- If discussing complex numbers (e.g., $5,000 loss), say "five thousand 
  dollars" instead of using digits to ensure the TTS (Text-to-Speech) 
  engine pronounces it perfectly.

## SIMLI OPTIMIZATION (LIP-SYNC)
- ENUNCIATION: Avoid overly technical jargon that creates "mumbled" 
  lip-syncing. If a word is very long, break it up or use a simpler synonym.
- INTERACTION: When the user finishes speaking, start with a brief
  acknowledgment like "That's a great question" to trigger the avatar's 
  mouth immediately while you "think" of the answer.

## DISCLOSURE
- Always maintain the persona, but if a user asks for a definitive 
  legal filing, state: "While I'm your AI guide, always double-check 
  the final numbers with a certified professional."
  `,
            audio: {
              input: {
                turn_detection: {
                  threshold: 0.5,
                },
              },
              output: {
                voice: "olivia", // Can change later
              },
            },
            tools: [
              {
                type: "function",
                name: "get_tax_documents",
                description: "Loads the intermediate representation (the storage vault) of all user tax documents, including W-2s, 1099s, etc. Call this when you need to answer questions about the user's tax data or do calculations.",
                parameters: {
                  type: "object",
                  properties: {},
                }
              }
            ],
          },
        };

        ws.send(JSON.stringify(sessionUpdate));
      } else if (response.type === "session.updated") {
        console.log("Session updated. Ready to start.");
        // First message to kick things off
        const welcome = {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                //text: "Hello, Alisa! Today I want to talk about tax strategies for my stock trading. Can you help me understand how wash-sale rules work?",
                text: "Hello, Alisa!"
              },
            ],
          },
        };

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(welcome));
          console.log("Sent Welcome Message");
          setChatHistory((prev) => [
            ...prev,
            { role: "user", content: welcome.item.content[0].text },
          ]);
        }
      } else if (response.type === "response.output_audio.delta") {
        const pcm24kRaw = base64ToUint8Array(response.delta);
        const int16_24k = new Int16Array(
          pcm24kRaw.buffer,
          pcm24kRaw.byteOffset,
          pcm24kRaw.byteLength / 2,
        );
        const int16_16k = downsampleTo16k(int16_24k);

        if (simliClientRef.current) {
          const audioBuffer = new Uint8Array(
            int16_16k.buffer,
            int16_16k.byteOffset,
            int16_16k.byteLength,
          );

          if (audioRef.current) {
            if (audioRef.current.paused) {
              audioRef.current
                .play()
                .catch((e) => console.error("Playback failed:", e));
            }
            audioRef.current.muted = false;
          }
          simliClientRef.current.sendAudioData(audioBuffer);
        }
      } else if (response.type === "input_audio_buffer.speech_started") {
        console.warn("User started speaking. Clearing buffers...");
        if (simliClientRef.current) {
          simliClientRef.current.ClearBuffer();
          setIsSpeaking(false);
        }
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
        }
      } else if (response.type === "response.function_call_arguments.done") {
        // Nova wants us to execute the function and return the results
        const fc = response;
        console.log("Advisor is calling function:", fc.name);
        
        let functionResult: any = {};
        try {
          if (fc.name === "get_tax_documents") {
            console.log("Providing tax documents from vault...");
            functionResult = { documents: vaultDocumentsRef.current };
          } else {
             functionResult = { error: "Function not found" };
          }
        } catch (err) {
          console.error("Function execution error:", err);
          functionResult = { error: String(err) };
        }

        // Send function output back
        wsRef.current?.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: fc.call_id,
              output: JSON.stringify(functionResult),
            },
          }),
        );
        // Prompt it to continue speaking using the function results:
        wsRef.current?.send(JSON.stringify({ type: "response.create" }));
      } else if (
        response.type ===
        "conversation.item.input_audio_transcription.completed"
      ) {
        console.log(
          `Response content part added (${response.type}): `,
          response,
        );
        setChatHistory((prev) => [
          ...prev,
          {
            role: "user",
            content: response.transcript,
          },
        ]);
      } else if (response.type === "response.output_item.done") {
        console.log(`Response output item done (${response.type}): `, response);
        const itemId = response.item?.id;

        response.item?.content?.forEach((part) => {
          if (part.transcript) {
            setChatHistory((prev) => {
              // Ensure we don't add duplicate messages by checking if the last message in history has the same ID
              const existingIndex = prev.findIndex((msg) => msg.id === itemId);
              if (existingIndex !== -1) {
                const updated = [...prev];
                updated[existingIndex] = { ...updated[existingIndex], content: part.transcript };
                return updated;
              }
              return [
                ...prev,
                {
                  id: itemId,
                  role: "assistant",
                  content: part.transcript,
                },
              ];
            });
          }
        });
      } else {
        console.log(`Message: ${response.type}: `,  response);
      }
    };

    ws.onerror = (e) => {
      console.error("Nova WebSocket Error", e);
      setError("Nova Connection Error. Check console logs.");
    };

    ws.onclose = (event) => {
      console.log("Nova WebSocket Closed", event.code, event.reason);
      if (ws !== wsRef.current) return;
      setIsSimliReady(false);
      if (simliClientRef.current) {
        simliClientRef.current.stop();
        simliClientRef.current = null;
      }
    };
  };

  const handleSendText = () => {
    if (!inputText.trim()) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError("AI is not connected. Please start interaction first.");
      return;
    }

    console.log("Sending user message:", inputText);

    wsRef.current.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: inputText }],
        },
      }),
    );

    // We omit response.create here as well because we have server VAD enabled.
    // wait, if we send a text message and it's set to server VAD, does it auto respond?
    // It might. But actually, "response.create is not supported when server VAD is enabled."
    // So we just have to omit it.

    setChatHistory((prev) => [...prev, { role: "user", content: inputText }]);
    setInputText("");
  };

  const startAudioRecording = async () => {
    try {
      // 24kHz is natively supported format for Nova Realtime API (pcm16)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true },
      });

      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const gainNode = audioContext.createGain();
      gainNode.gain.value = 1.5;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      startVisualizer();

      await audioContext.audioWorklet.addModule("/pcm-processor.js");

      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
      processorRef.current = workletNode;

      // Buffer audio so we don't hit Amazon Nova's WebSocket rate limits (128 samples per message is too fast)
      let audioBufferChunk: Int16Array[] = [];
      let totalSamples = 0;
      const TARGET_SAMPLES = 4800; // 200ms at 24kHz

      workletNode.port.onmessage = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
          return;

        const pcmData = new Int16Array(event.data);
        audioBufferChunk.push(pcmData);
        totalSamples += pcmData.length;

        if (totalSamples >= TARGET_SAMPLES) {
          // Combine chunks
          const combined = new Int16Array(totalSamples);
          let offset = 0;
          for (const chunk of audioBufferChunk) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }

          const buffer = new ArrayBuffer(combined.length * 2);
          const view = new DataView(buffer);

          for (let i = 0; i < combined.length; i++) {
            view.setInt16(i * 2, combined[i], true);
          }

          const base64Audio = arrayBufferToBase64(buffer);

          wsRef.current.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: base64Audio,
            }),
          );

          // Reset
          audioBufferChunk = [];
          totalSamples = 0;
        }
      };

      source.connect(gainNode);
      gainNode.connect(analyser);
      gainNode.connect(workletNode);
      workletNode.connect(audioContext.destination);
    } catch (e) {
      console.error("Mic Error:", e);
    }
  };

  useEffect(() => {
    if (hasInteracted) {
      initialize();
    }
    return () => {
      console.log("Cleaning up Simli & Nova...");
      isInitializing.current = false; // Allow re-initialization
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (simliClientRef.current) {
        simliClientRef.current.stop();
        simliClientRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (playbackContextRef.current) {
        playbackContextRef.current.close();
        playbackContextRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [hasInteracted]);

  // Handle Output Volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = isAudioMuted;
      audioRef.current.volume = volume;
    }
  }, [volume, isAudioMuted]);

  // Handle Input Mute
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !isMicMuted;
      });
    }
  }, [isMicMuted]);


  const startVisualizer = () => {
    if (!canvasRef.current || !analyserRef.current) return;

    if (animationFrameRef.current)
      cancelAnimationFrame(animationFrameRef.current);

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const renderFrame = () => {
      if (!canvasRef.current || !analyserRef.current) return;

      analyserRef.current.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barCount = 60;
      const barWidth = canvas.width / barCount - 2;
      let x = 0;

      ctx.fillStyle = dominantColorRef.current || "rgba(182, 182, 255, 0.8)";

      for (let i = 0; i < barCount; i++) {
        const ratio = i / barCount;
        const spectrumSize = bufferLength * 0.7;
        const index = Math.floor(Math.pow(ratio, 1.7) * spectrumSize);
        const safeIndex = Math.min(index, bufferLength - 1);
        const barHeight = (dataArray[safeIndex] / 255) * canvas.height;

        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 2;
      }

      animationFrameRef.current = requestAnimationFrame(renderFrame);
    };

    renderFrame();
  };

  // Handle Chat Scroll on new content from Gemini
  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop =
        chatContainerRef.current.scrollHeight;
    }
  };

  const handleScroll = () => {
    if (chatContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } =
        chatContainerRef.current;
      // 50px threshold to determine if user is at the bottom
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      isAtBottomRef.current = isAtBottom;
    }
  };

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [chatHistory]);

  return (
    <div className="flex flex-row bg-black items-center justify-center min-h-screen h-screen overflow-hidden text-white font-sans p-4 gap-8">
      {/* Transcript Section (Left Side) */}
      {showTranscript && (
        <div className="flex flex-col w-full max-w-2xl h-full animate-in fade-in slide-in-from-left-4 duration-300 pb-8">
          <div
            ref={chatContainerRef}
            onScroll={handleScroll}
            className="flex-1 bg-gray-900 rounded-lg p-4 overflow-y-auto text-sm text-gray-300 border border-gray-800 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent flex flex-col gap-3 shadow-inner"
          >
            {chatHistory.length === 0 && (
              <p className="text-gray-500 italic text-center text-xs my-auto">
                Conversation will appear here...
              </p>
            )}
            {chatHistory.map((msg, idx) => (
              <div
                key={idx}
                className={`flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`px-4 py-3 rounded-2xl max-w-[90%] text-sm whitespace-pre-wrap relative group/msg ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-br-none"
                      : "bg-gray-700 text-gray-100 rounded-bl-none pr-10"
                  }`}
                >
                  {msg.content}
                  {msg.isImageLoading && (
                    <div className="mt-4 w-64 h-64 bg-gray-800 animate-pulse rounded-lg flex items-center justify-center border border-gray-600">
                      <span className="text-gray-400 text-xs">
                        Generating Cover Art...
                      </span>
                    </div>
                  )}
                  {msg.image && (
                    <div className="mt-4">
                      <img
                        src={msg.image}
                        alt="Generated Album Art"
                        className="w-64 h-64 object-cover rounded-lg shadow-md border border-gray-600"
                      />
                    </div>
                  )}
                  {msg.role === "assistant" && (
                    <button
                      onClick={() => handleDownload(msg.content, idx)}
                      className="absolute top-2 right-2 text-gray-400 hover:text-white opacity-0 group-hover/msg:opacity-100 transition-opacity p-1 bg-gray-700/50 rounded-full backdrop-blur-sm"
                      title="Download this message"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Center Area: Avatar, Visualizer, Input */}
      <div className="flex flex-col gap-6 max-w-[512px] w-full h-full items-center justify-start min-h-0">
        {/* Avatar Container - Flexible width between 180px and 512px, square aspect ratio */}
        <div
          className={`relative w-full aspect-square min-w-[180px] max-w-[512px] min-h-[180px] shrink bg-black overflow-hidden flex items-center justify-center border rounded-lg shadow-xl transition-all duration-700 ease-in-out group ${
            isSpeaking
              ? "animate-ai-pulse border-blue-400 scale-[1.02]"
              : "border-gray-800 scale-100"
          }`}
        >
          {/* Helper message if not started */}
          {!hasInteracted ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20 text-white flex-col gap-4">
              <h2 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                Tax Advisor Alisa is ready to assist you!
              </h2>
              <button
                onClick={() => setHasInteracted(true)}
                className="px-6 py-2 bg-blue-600 rounded hover:bg-blue-700 transition font-semibold"
              >
                Start Interaction
              </button>
            </div>
          ) : null}

          {/* Video Element for Simli */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className={`w-full h-full object-cover transition-opacity duration-1000 ${
              isSimliReady ? "opacity-100" : "opacity-0"
            }`}
          />

          {/* Active Indicator Dot */}
          {isSpeaking && (
            <div className="absolute top-4 right-4 flex h-3 w-3 z-40">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
            </div>
          )}

          <audio ref={audioRef} autoPlay muted className="hidden" />

          {/* Status / Error Overlay */}
          {(error || (!isSimliReady && hasInteracted && !error)) && (
            <div className="absolute top-2 left-2 right-2 bg-black/50 text-white text-xs p-2 rounded z-30 pointer-events-none text-center backdrop-blur-sm">
              {error ? (
                <span className="text-red-400">{error}</span>
              ) : (
                "Connecting to Simli & AI..."
              )}
            </div>
          )}

          {/* Bottom Controls Overlay */}
          <div className="absolute bottom-4 left-4 right-4 flex justify-between items-center z-40 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            {/* Left: Mic Toggle */}
            <div className="flex items-center gap-4">
              <button
                onClick={() => setIsMicMuted(!isMicMuted)}
                className={`p-3 rounded-full transition-all shadow-lg ${
                  isMicMuted
                    ? "bg-red-600 hover:bg-red-700 text-white"
                    : "bg-gray-800/80 hover:bg-gray-700 text-white backdrop-blur-sm"
                }`}
                title={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
              >
                {isMicMuted ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                    <line x1="12" y1="19" x2="12" y2="23"></line>
                    <line x1="8" y1="23" x2="16" y2="23"></line>
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                    <line x1="12" y1="19" x2="12" y2="23"></line>
                    <line x1="8" y1="23" x2="16" y2="23"></line>
                  </svg>
                )}
              </button>
              {/* End Conversation Button */}
              {hasInteracted && (
                <button
                  onClick={() => {
                    setHasInteracted(false);
                    setIsSimliReady(false);
                  }}
                  className="p-3 rounded-full bg-red-600 hover:bg-red-700 text-white transition-all shadow-lg"
                  title="End Conversation"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                    <line x1="12" y1="2" x2="12" y2="12"></line>
                  </svg>
                </button>
              )}
            </div>

            {/* Middle: Controls */}
            <div className="flex items-center gap-4">
              {/* Thinking Toggle */}
              <button
                onClick={() => setShowThinking(!showThinking)}
                className={`p-3 rounded-full transition-all shadow-lg ${
                  showThinking
                    ? "bg-purple-600 hover:bg-purple-700 text-white"
                    : "bg-gray-800/80 hover:bg-gray-700 text-white backdrop-blur-sm"
                }`}
                title="Toggle Thinking Output"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M4,18 C5.1045695,18 6,18.8954305 6,20 C6,21.1045695 5.1045695,22 4,22 C2.8954305,22 2,21.1045695 2,20 C2,18.8954305 2.8954305,18 4,18 Z M9.5,15 C10.8807119,15 12,16.1192881 12,17.5 C12,18.8807119 10.8807119,20 9.5,20 C8.11928813,20 7,18.8807119 7,17.5 C7,16.1192881 8.11928813,15 9.5,15 Z M12,2 C14.6592222,2 16.8838018,3.92259542 17.3302255,6.47059089 L17.4117647,6.47058824 C19.4909544,6.47058824 21.1764706,8.15610447 21.1764706,10.2352941 C21.1764706,12.3144838 19.4909544,14 17.4117647,14 L6.58823529,14 C4.50904565,14 2.82352941,12.3144838 2.82352941,10.2352941 C2.82352941,8.15610447 4.50904565,6.47058824 6.58825824,6.47058824 L6.66977451,6.47059089 C7.11619821,3.92259542 9.34077777,2 12,2 Z"></path>
                </svg>
              </button>

              {/* Transcript Toggle */}
              <button
                onClick={() => setShowTranscript(!showTranscript)}
                className={`p-3 rounded-full transition-all shadow-lg ${
                  showTranscript
                    ? "bg-blue-600 hover:bg-blue-700 text-white"
                    : "bg-gray-800/80 hover:bg-gray-700 text-white backdrop-blur-sm"
                }`}
                title="Toggle Transcript"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="16" y1="13" x2="8" y2="13"></line>
                  <line x1="16" y1="17" x2="8" y2="17"></line>
                  <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
              </button>
            </div>

            {/* Right: Volume Control */}
            <div className="flex items-center gap-2 bg-gray-800/80 backdrop-blur-sm rounded-full p-2 pr-4 shadow-lg group/vol">
              <button
                onClick={() => setIsAudioMuted(!isAudioMuted)}
                className="p-1 hover:text-blue-400 transition-colors"
                title={isAudioMuted ? "Unmute Audio" : "Mute Audio"}
              >
                {isAudioMuted ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <line x1="23" y1="9" x2="17" y2="15"></line>
                    <line x1="17" y1="9" x2="23" y2="15"></line>
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                  </svg>
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                onChange={(e) => {
                  setVolume(parseFloat(e.target.value));
                  setIsAudioMuted(false);
                }}
                className="w-20 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer hover:bg-blue-500 accent-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Audio Visualizer */}
        <canvas
          ref={canvasRef}
          width={512}
          height={30}
          className="w-full max-w-[512px] h-[30px] flex-shrink-0"
        />

        {/* Text Input Area (Always Visible under the visualizer) */}
        <div className="flex gap-2 w-full max-w-[512px]">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSendText();
              }
            }}
            placeholder="Type a message..."
            className="flex-1 bg-gray-800 text-white rounded p-3 text-sm border border-gray-700 outline-none focus:border-blue-500 transition-colors shadow-inner"
          />
          <button
            onClick={handleSendText}
            type="button"
            disabled={!inputText.trim()}
            className={`px-6 py-3 bg-blue-600 rounded text-sm font-bold shadow-lg hover:bg-blue-700 transition-colors ${!inputText.trim() ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            Send
          </button>
        </div>
      </div>

      {/* Document Scanning & Vault Section (Right Side) */}
      <div className="flex flex-col w-full max-w-md h-full animate-in fade-in slide-in-from-right-4 duration-300 pb-8 pt-8 items-center justify-start gap-4 overflow-hidden">
        {/* Scanner Panel */}
        <div className="bg-gray-900 rounded-lg w-full p-4 border border-gray-800 shadow-inner flex flex-col gap-4 flex-shrink-0">
          <h3 className="text-white font-bold text-lg text-center">Tax Document Scanner</h3>
          
          <input 
            type="file" 
            multiple 
            accept=".pdf,image/png,image/jpeg,image/webp" 
            onChange={handleFileChange}
            className="text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-purple-600 file:text-white hover:file:bg-purple-700" 
          />
          
          {scanFiles.length > 0 && (
            <div className="text-sm text-gray-300">
              {scanFiles.length} file(s) selected
              <ul className="list-disc pl-4 mt-2 max-h-24 overflow-y-auto">
                {scanFiles.map((f, i) => (
                  <li key={i} className="truncate">{f.name}</li>
                ))}
              </ul>
            </div>
          )}

          <button 
            onClick={scanSelectedFiles} 
            disabled={isScanning || scanFiles.length === 0}
            className={`font-bold py-3 px-6 rounded-lg w-full transition-colors shadow-lg flex items-center justify-center gap-2 ${
              isScanning || scanFiles.length === 0 
                ? "bg-gray-600 text-gray-400 cursor-not-allowed" 
                : "bg-purple-600 hover:bg-purple-700 text-white"
            }`}
          >
            {isScanning ? (
              <span>Scanning...</span>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                Scan with Vision AI
              </>
            )}
          </button>
        </div>

        {/* Vault Panel (Intermediate Representation) */}
        <div className="bg-gray-900 rounded-lg border border-gray-800 flex flex-col shadow-inner w-full flex-1 overflow-hidden p-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-white font-bold text-lg flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2v16l2 2H3l2-2V4L3 2z"></path><line x1="9" y1="2" x2="9" y2="22"></line><line x1="15" y1="2" x2="15" y2="22"></line></svg>
              Document Vault
            </h3>
            <span className="text-xs bg-blue-600 px-2 py-1 rounded-full">{vaultDocuments.length} Records</span>
          </div>

          <div className="flex-1 overflow-y-auto pr-2 space-y-4 scrollbar-thin scrollbar-thumb-gray-700">
            {vaultDocuments.length === 0 ? (
              <p className="text-gray-500 text-sm italic text-center mt-10">No documents scanned yet.<br/>Upload a tax form above.</p>
            ) : (
              vaultDocuments.map((doc, idx) => (
                <div key={doc.id} className={`bg-gray-800 p-3 rounded-md border ${doc.isReviewing || !doc.owner || !doc.taxYear || !doc.formName ? 'border-amber-500' : 'border-gray-700'}`}>
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-xs font-bold text-purple-400">#{doc.ordinalNumber} - {doc.id}</span>
                    <button 
                      onClick={() => {
                        const newVault = vaultDocuments.filter(d => d.id !== doc.id);
                        setVaultDocuments(newVault);
                        vaultDocumentsRef.current = newVault;
                      }}
                      className="text-red-400 hover:text-red-300 p-1"
                      title="Delete"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col">
                      <label className="text-[10px] text-gray-400 uppercase">Owner Name</label>
                      <input 
                        type="text" 
                        value={doc.owner} 
                        onChange={(e) => {
                          const newDocs = [...vaultDocuments];
                          newDocs[idx].owner = e.target.value;
                          setVaultDocuments(newDocs);
                          vaultDocumentsRef.current = newDocs;
                        }}
                        className={`bg-gray-900 border ${!doc.owner ? 'border-amber-500' : 'border-gray-700'} text-xs p-1.5 rounded text-white`}
                        placeholder="e.g. John Doe"
                      />
                    </div>
                    
                    <div className="flex gap-2">
                      <div className="flex flex-col flex-1">
                        <label className="text-[10px] text-gray-400 uppercase">Form Type</label>
                        <input 
                          type="text" 
                          value={doc.formName} 
                          onChange={(e) => {
                            const newDocs = [...vaultDocuments];
                            newDocs[idx].formName = e.target.value;
                            setVaultDocuments(newDocs);
                            vaultDocumentsRef.current = newDocs;
                          }}
                          className={`bg-gray-900 border ${!doc.formName ? 'border-amber-500' : 'border-gray-700'} text-xs p-1.5 rounded text-white`}
                          placeholder="e.g. 1099-B"
                        />
                      </div>
                      <div className="flex flex-col flex-1">
                        <label className="text-[10px] text-gray-400 uppercase">Tax Year</label>
                        <input 
                          type="text" 
                          value={doc.taxYear} 
                          onChange={(e) => {
                            const newDocs = [...vaultDocuments];
                            newDocs[idx].taxYear = e.target.value;
                            setVaultDocuments(newDocs);
                            vaultDocumentsRef.current = newDocs;
                          }}
                          className={`bg-gray-900 border ${!doc.taxYear ? 'border-amber-500' : 'border-gray-700'} text-xs p-1.5 rounded text-white`}
                          placeholder="e.g. 2023"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col">
                      <label className="text-[10px] text-gray-400 uppercase">Extracted Data (JSON)</label>
                      <textarea 
                        value={doc.dataFields}
                        onChange={(e) => {
                          const newDocs = [...vaultDocuments];
                          newDocs[idx].dataFields = e.target.value;
                          setVaultDocuments(newDocs);
                          vaultDocumentsRef.current = newDocs;
                        }}
                        className="bg-gray-900 border border-gray-700 text-green-400 text-xs p-1.5 rounded font-mono h-24 resize-y"
                      />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SimliLiveNova;
