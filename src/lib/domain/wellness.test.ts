import { describe, expect, it } from 'vitest';
import {
  WELLNESS_SCORE_MAX,
  WELLNESS_SCORE_MIN,
  clampWellnessScore,
  normalizeWellnessScoreInput,
  parseWellnessScore,
} from './wellness';

describe('clampWellnessScore', () => {
  it('returns values inside the range unchanged', () => {
    expect(clampWellnessScore(5)).toBe(5);
    expect(clampWellnessScore(WELLNESS_SCORE_MIN)).toBe(WELLNESS_SCORE_MIN);
    expect(clampWellnessScore(WELLNESS_SCORE_MAX)).toBe(WELLNESS_SCORE_MAX);
  });

  it('clamps to the configured min and max', () => {
    expect(clampWellnessScore(-3)).toBe(WELLNESS_SCORE_MIN);
    expect(clampWellnessScore(99)).toBe(WELLNESS_SCORE_MAX);
  });
});

describe('parseWellnessScore', () => {
  it('returns undefined for empty / whitespace input', () => {
    expect(parseWellnessScore('')).toBeUndefined();
    expect(parseWellnessScore('   ')).toBeUndefined();
  });

  it('returns undefined for non-numeric input', () => {
    expect(parseWellnessScore('great')).toBeUndefined();
  });

  it('parses and clamps numeric input', () => {
    expect(parseWellnessScore('5')).toBe(5);
    expect(parseWellnessScore('-2')).toBe(WELLNESS_SCORE_MIN);
    expect(parseWellnessScore('99')).toBe(WELLNESS_SCORE_MAX);
  });

  it('accepts decimal input', () => {
    expect(parseWellnessScore('4.5')).toBe(4.5);
  });
});

describe('normalizeWellnessScoreInput', () => {
  it('returns "" for unparseable input so the cell renders empty', () => {
    expect(normalizeWellnessScoreInput('')).toBe('');
    expect(normalizeWellnessScoreInput('bad')).toBe('');
  });

  it('is idempotent for already-normalized values', () => {
    expect(normalizeWellnessScoreInput('5')).toBe('5');
    expect(normalizeWellnessScoreInput(normalizeWellnessScoreInput('5'))).toBe('5');
  });

  it('clamps out-of-range numeric input', () => {
    expect(normalizeWellnessScoreInput('-5')).toBe(String(WELLNESS_SCORE_MIN));
    expect(normalizeWellnessScoreInput('25')).toBe(String(WELLNESS_SCORE_MAX));
  });
});
