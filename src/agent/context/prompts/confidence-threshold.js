export function getHoldConfidenceThreshold(personalityAgent = 'moderate') {
  const personality = String(personalityAgent || 'moderate').toLowerCase();

  if (personality === 'aggressive') return 40;
  if (personality === 'conservative') return 55;
  return 45;
}
