export interface PlaudCredentials {
  email: string;
  password: string;
  region: 'us' | 'eu';
}

export interface PlaudTokenData {
  accessToken: string;
  tokenType: string;
  issuedAt: number;   // epoch ms
  expiresAt: number;  // epoch ms (decoded from JWT)
}

export interface PlaudConfig {
  credentials?: PlaudCredentials;
  token?: PlaudTokenData;
}

export const BASE_URLS: Record<string, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
};

export interface PlaudRecording {
  id: string;
  filename: string;
  fullname: string;
  filesize: number;
  duration: number;
  start_time: number;
  end_time: number;
  is_trash: boolean;
  is_trans: boolean;
  is_summary: boolean;
  keywords: string[];
  serial_number: string;
}

export interface PlaudTranscriptSegment {
  content: string;
  start_time: number;        // ms from recording start
  end_time: number;          // ms
  speaker: string;           // resolved name when voice-printed, else "Speaker N"
  original_speaker: string;  // raw diarization label, "Speaker N"
  embeddingKey?: string;
}

export interface PlaudRecordingDetail extends PlaudRecording {
  transcript: string;                       // AI summary text
  summary?: string;
  rawTranscript: PlaudTranscriptSegment[];  // verbatim diarized segments
  speakers: string[];                       // distinct speaker names in this recording
}

export interface PlaudUserInfo {
  id: string;
  nickname: string;
  email: string;
  country: string;
  membership_type: string;
}
