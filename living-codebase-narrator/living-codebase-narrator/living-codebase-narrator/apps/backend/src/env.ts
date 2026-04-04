import path from 'node:path';
import dotenv from 'dotenv';

const envCandidates = [
  path.resolve(process.cwd(), '../../../../../.env'),
  path.resolve(process.cwd(), '../../../../../.env.local'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(process.cwd(), '../../.env.local'),
  path.resolve(process.cwd(), '.env')
];

for (const filePath of envCandidates) {
  dotenv.config({ path: filePath, override: false });
}

export const env = {
  PORT: Number(process.env.PORT ?? process.env.LCN_PORT ?? process.env.NARRATOR_PORT ?? '8787'),
  PUBLIC_BASE_URL:
    process.env.LCN_PUBLIC_BASE_URL ??
    process.env.NARRATOR_PUBLIC_BASE_URL ??
    `http://localhost:${process.env.PORT ?? process.env.LCN_PORT ?? process.env.NARRATOR_PORT ?? '8787'}`,
  LOCAL_DATA_DIR: process.env.LCN_LOCAL_DATA_DIR ?? process.env.NARRATOR_LOCAL_DATA_DIR ?? '.data',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite',

  HF_TOKEN: process.env.HF_TOKEN ?? '',
  HF_MODEL: process.env.HF_MODEL ?? 'Qwen/Qwen2.5-Coder-32B-Instruct',

  MONGODB_URI: process.env.MONGODB_URI ?? '',
  MONGODB_DB: process.env.LCN_MONGODB_DB ?? process.env.MONGODB_DB ?? 'living_codebase_narrator',

  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY ?? '',
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM',
  NARRATOR_HEADING_PREFIX:
    process.env.NARRATOR_HEADING_PREFIX ?? 'Latest code update.'
};
