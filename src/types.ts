export interface SongInput {
  title: string;
  artist: string;
  sourceLanguage: string;
  targetLanguage: string;
  lyrics: string;
  genre?: string;
}

export interface VocabItem {
  term: string;
  type: "slang" | "idiom" | "standard" | "colloquial";
  register: "formal" | "informal" | "vulgar";
  definition: string;
  exampleLine: string;
  difficulty: 1 | 2 | 3;
}

export interface GrammarPattern {
  pattern: string;
  explanation: string;
  exampleLine: string;
}

export interface ExtractedConcepts {
  level: "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
  vocabulary: VocabItem[];
  grammarPatterns: GrammarPattern[];
  culturalNotes: string[];
}

export interface Exercise {
  type: "gap-fill" | "translation" | "multiple-choice" | "free-write";
  prompt: string;
  answer: string;
  hint?: string;
}

export interface ReviewSchedule {
  initialReviewDays: number;
  intervals: number[];
}

export interface LearningUnit {
  order: number;
  title: string;
  focusType: "vocabulary" | "grammar" | "culture" | "pronunciation";
  items: string[];
  exercises: Exercise[];
  reviewSchedule: ReviewSchedule;
}

export interface LearningPlan {
  summary: string;
  estimatedHours: number;
  units: LearningUnit[];
}

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  GROQ_API_KEY: string;
  API_KEY: string;
}
