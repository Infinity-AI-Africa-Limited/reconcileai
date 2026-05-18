import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Scoring logic unit tests ─────────────────────────────────────────────────
// These test the pure scoring algorithm extracted from the assessment router.

function computeScore(answers: { questionId: string; score: number }[]) {
  const categoryMap: Record<string, string> = {
    q1: "reconciliation", q2: "reconciliation", q3: "reconciliation", q4: "reconciliation", q5: "reconciliation",
    q6: "exception", q7: "exception", q8: "exception", q9: "exception", q10: "exception",
    q11: "reporting", q12: "reporting", q13: "reporting", q14: "reporting", q15: "reporting",
    q16: "regulatory", q17: "regulatory", q18: "regulatory", q19: "regulatory", q20: "regulatory",
    q21: "technology", q22: "technology", q23: "technology", q24: "technology", q25: "technology",
  };

  const categoryScores: Record<string, number> = {
    reconciliation: 0, exception: 0, reporting: 0, regulatory: 0, technology: 0,
  };
  const categoryCounts: Record<string, number> = {
    reconciliation: 0, exception: 0, reporting: 0, regulatory: 0, technology: 0,
  };

  for (const answer of answers) {
    const cat = categoryMap[answer.questionId];
    if (cat) {
      categoryScores[cat] += answer.score;
      categoryCounts[cat]++;
    }
  }

  // Normalise each category to 0–100
  const normalisedScores: Record<string, number> = {};
  for (const cat of Object.keys(categoryScores)) {
    const count = categoryCounts[cat] ?? 0;
    const maxPossible = count * 5;
    normalisedScores[cat] = maxPossible > 0
      ? Math.round((categoryScores[cat] / maxPossible) * 100)
      : 0;
  }

  const cats = Object.keys(normalisedScores);
  const overallScore = cats.length > 0
    ? Math.round(cats.reduce((sum, c) => sum + normalisedScores[c], 0) / cats.length)
    : 0;

  const riskLevel =
    overallScore >= 80 ? "low" :
    overallScore >= 60 ? "medium" :
    overallScore >= 40 ? "high" : "critical";

  return { categoryScores: normalisedScores, overallScore, riskLevel };
}

describe("Assessment scoring logic", () => {
  it("returns 100 overall when all answers score 5", () => {
    const answers = Array.from({ length: 25 }, (_, i) => ({
      questionId: `q${i + 1}`,
      score: 5,
    }));
    const result = computeScore(answers);
    expect(result.overallScore).toBe(100);
    expect(result.riskLevel).toBe("low");
    for (const cat of Object.keys(result.categoryScores)) {
      expect(result.categoryScores[cat]).toBe(100);
    }
  });

  it("returns 0 overall when all answers score 0", () => {
    const answers = Array.from({ length: 25 }, (_, i) => ({
      questionId: `q${i + 1}`,
      score: 0,
    }));
    const result = computeScore(answers);
    expect(result.overallScore).toBe(0);
    expect(result.riskLevel).toBe("critical");
  });

  it("correctly assigns risk level 'high' for score 40–59", () => {
    // Mix of 2s and 3s to land in 40–59 range
    const answers = Array.from({ length: 25 }, (_, i) => ({
      questionId: `q${i + 1}`,
      score: i % 2 === 0 ? 2 : 3,
    }));
    const result = computeScore(answers);
    expect(result.overallScore).toBeGreaterThanOrEqual(40);
    expect(result.overallScore).toBeLessThan(60);
    expect(result.riskLevel).toBe("high");
  });

  it("correctly assigns risk level 'medium' for score 60–79", () => {
    const answers = Array.from({ length: 25 }, (_, i) => ({
      questionId: `q${i + 1}`,
      score: i % 3 === 0 ? 4 : 3,
    }));
    const result = computeScore(answers);
    expect(result.overallScore).toBeGreaterThanOrEqual(60);
    expect(result.overallScore).toBeLessThan(80);
    expect(result.riskLevel).toBe("medium");
  });

  it("handles partial answers (fewer than 25 questions)", () => {
    const answers = [
      { questionId: "q1", score: 5 },
      { questionId: "q2", score: 5 },
    ];
    const result = computeScore(answers);
    // reconciliation category: 2 questions answered, both 5 → 100
    expect(result.categoryScores.reconciliation).toBe(100);
    // other categories: 0 answers → 0
    expect(result.categoryScores.exception).toBe(0);
  });

  it("normalises category scores independently", () => {
    const answers = [
      // reconciliation: all 5s → 100
      ...["q1","q2","q3","q4","q5"].map(id => ({ questionId: id, score: 5 })),
      // exception: all 0s → 0
      ...["q6","q7","q8","q9","q10"].map(id => ({ questionId: id, score: 0 })),
      // reporting: mix → 60
      ...["q11","q12","q13","q14","q15"].map(id => ({ questionId: id, score: 3 })),
      // regulatory: all 5s → 100
      ...["q16","q17","q18","q19","q20"].map(id => ({ questionId: id, score: 5 })),
      // technology: all 0s → 0
      ...["q21","q22","q23","q24","q25"].map(id => ({ questionId: id, score: 0 })),
    ];
    const result = computeScore(answers);
    expect(result.categoryScores.reconciliation).toBe(100);
    expect(result.categoryScores.exception).toBe(0);
    expect(result.categoryScores.reporting).toBe(60);
    expect(result.categoryScores.regulatory).toBe(100);
    expect(result.categoryScores.technology).toBe(0);
    // overall = (100 + 0 + 60 + 100 + 0) / 5 = 52
    expect(result.overallScore).toBe(52);
    expect(result.riskLevel).toBe("high");
  });
});

describe("Assessment token generation", () => {
  it("generates a 48-character hex token", () => {
    const { randomBytes } = require("crypto");
    const token = randomBytes(24).toString("hex");
    expect(token).toHaveLength(48);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it("generates unique tokens on each call", () => {
    const { randomBytes } = require("crypto");
    const t1 = randomBytes(24).toString("hex");
    const t2 = randomBytes(24).toString("hex");
    expect(t1).not.toBe(t2);
  });
});
