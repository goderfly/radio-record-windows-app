import type { RecordMiniBridge, StreamStatusEvent } from "@shared/types";

declare global {
  interface Window {
    recordMini: RecordMiniBridge;
    recordMiniEvents: {
      onStreamStatus(cb: (event: StreamStatusEvent) => void): () => void;
    };
  }
}

export {};
