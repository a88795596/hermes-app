import { NativeModule, requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type SpeechState = "starting" | "recording" | "stopping" | "idle";
export type SpeechResult = { id: string; text: string; isFinal: boolean };

declare class SpeechRecognitionModule extends NativeModule<{
  result: (event: SpeechResult) => void;
  status: (event: { id: string; state: SpeechState }) => void;
  error: (event: { id: string; message: string }) => void;
}> {
  isAvailable(): boolean;
  start(id: string): Promise<void>;
  stop(id: string): Promise<string>;
  cancel(id: string): Promise<void>;
}

export default Platform.OS === "ios" || Platform.OS === "android"
  ? requireOptionalNativeModule<SpeechRecognitionModule>(
      "HermesSpeechRecognition",
    )
  : null;
