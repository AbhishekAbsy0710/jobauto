import { loadProfile } from '../config.js';

/**
 * Career-Ops style scorer.
 * Converts A–F dimension grades to weighted numeric score.
 * Applies deterministic business rules for risk, action, and priority.
 */

const GRADE_VALUES = { A: 5, B: 4, C: 3, D: 2, F: 0 };
const GRADE_FROM_SCORE = (s) => s >= 4.5 ? 'A' : s >= 3.5 ? 'B' : s >= 2.5 ? 'C' : s >= 1.5 ? 'D' : 'F';

export function applyBusinessRules(aiResult, job) {
  if (!aiResult) return null;

  // ============================================
  // HARD EU GATE — reject non-EU locations immediately
  // ============================================
  const loc = (job.location || '').toLowerCase();
  const EU_KEYWORDS = [
    'remote', 'europe', 'emea', 'dach', 'eu ',
    'germany', 'munich', 'berlin', 'hamburg', 'frankfurt', 'cologne', 'stuttgart', 'düsseldorf', 'dresden', 'leipzig', 'nuremberg',
    'switzerland', 'zurich', 'zürich', 'geneva', 'basel', 'bern', 'lucerne',
    'luxembourg',
    'netherlands', 'amsterdam', 'rotterdam', 'den haag', 'eindhoven', 'utrecht',
    'austria', 'vienna', 'graz', 'linz',
    'belgium', 'brussels', 'antwerp', 'ghent',
    'france', 'paris', 'lyon', 'marseille', 'toulouse', 'bordeaux', 'nantes', 'grenoble', 'montpellier', 'nice', 'sophia antipolis',
    'ireland', 'dublin',
    'uk', 'united kingdom', 'london', 'manchester', 'edinburgh', 'cambridge', 'bristol', 'oxford',
    'sweden', 'stockholm', 'gothenburg', 'malmö',
    'denmark', 'copenhagen',
    'norway', 'oslo',
    'finland', 'helsinki', 'tampere', 'espoo',
    'poland', 'warsaw', 'krakow', 'wroclaw', 'gdansk',
    'czech', 'prague', 'brno',
    'spain', 'madrid', 'barcelona', 'valencia',
    'portugal', 'lisbon', 'porto',
    'italy', 'milan', 'rome', 'turin',
    'romania', 'bucharest',
    'hungary', 'budapest',
    'estonia', 'tallinn',
    'latvia', 'riga',
    'lithuania', 'vilnius',
    'slovenia', 'ljubljana',
    'croatia', 'zagreb',
    'bulgaria', 'sofia',
    'greece', 'athens',
  ];
  const NON_EU_KEYWORDS = [
    'united states', 'usa', ' us', 'california', 'new york', 'san francisco', 'seattle', 'boston', 'washington', 'chicago', 'austin', 'los angeles', 'denver', 'atlanta', 'portland', 'philadelphia',
    'canada', 'toronto', 'vancouver', 'montreal',
    'india', 'bangalore', 'hyderabad', 'mumbai', 'pune', 'chennai', 'delhi',
    'singapore', 'japan', 'tokyo', 'korea', 'seoul',
    'china', 'beijing', 'shanghai', 'shenzhen',
    'brazil', 'são paulo', 'sao paulo',
    'israel', 'tel aviv',
    'australia', 'sydney', 'melbourne',
    'mexico', 'argentina',
  ];
  const hasNonEU = NON_EU_KEYWORDS.some(k => loc.includes(k));
  const hasEU = EU_KEYWORDS.some(k => loc.includes(k));
  if (hasNonEU && !hasEU) {
    return { ...aiResult, letter_grade: 'F', weighted_score: 0, action: 'Skip', priority: 'low', reason: `Non-EU location rejected: ${job.location}` };
  }

  const profile = loadProfile();
  const result = { ...aiResult };
  const weights = profile.scoring_weights || {};
  const dims = result.dimension_scores || {};

  // ============================================
  // STEP 1: Calculate Weighted Score from A–F grades
  // ============================================
  const dimensionKeys = [
    'technical_fit', 'seniority_alignment', 'domain_relevance',
    'growth_potential', 'company_signal', 'compensation_fit',
    'location_remote', 'cultural_indicators', 'tech_stack_freshness',
    'visa_sponsorship'
  ];

  let totalWeight = 0;
  let weightedSum = 0;

  for (const key of dimensionKeys) {
    const dim = dims[key];
    const weight = weights[key] || 0.10;
    const grade = dim?.grade || 'C';
    const value = GRADE_VALUES[grade] ?? 3;

    weightedSum += value * weight;
    totalWeight += weight;
  }

  // Normalize if weights don't sum to 1
  const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  result.weighted_score = Math.round(rawScore * 100) / 100;
  result.letter_grade = GRADE_FROM_SCORE(result.weighted_score);

  // Backward-compatible match_percentage (0-100 scale)
  result.match_percentage = Math.round((result.weighted_score / 5) * 100);
  result.ranking_score = Math.round(result.weighted_score * 20); // 0-100 scale

  // Dimension sub-scores for backward compat
  result.skill_depth_score = GRADE_VALUES[dims.technical_fit?.grade || 'C'] * 20;
  result.role_alignment_score = GRADE_VALUES[dims.seniority_alignment?.grade || 'C'] * 20;

  // ============================================
  // STEP 2: Deal Breaker Check
  // ============================================
  const dealBreakers = profile.deal_breakers || [];
  const jobText = `${job.title} ${job.description || ''}`.toLowerCase();
  const hasDealBreaker = dealBreakers.some(db => jobText.includes(db.toLowerCase()));

  if (hasDealBreaker) {
    result.letter_grade = 'F';
    result.weighted_score = 0;
    result.match_percentage = 0;
    result.reason = 'Deal breaker detected: ' + dealBreakers.find(db => jobText.includes(db.toLowerCase()));
  }

  // ============================================
  // STEP 2b: EU Location Gate
  // ============================================
  const EU_LOCATIONS = [
    'switzerland', 'zurich', 'zürich', 'bern', 'geneva', 'basel', 'lausanne',
    'germany', 'berlin', 'munich', 'münchen', 'frankfurt', 'hamburg', 'cologne', 'düsseldorf', 'stuttgart',
    'luxembourg',
    'netherlands', 'amsterdam', 'rotterdam', 'den haag', 'utrecht', 'eindhoven',
    'austria', 'vienna', 'wien', 'graz', 'salzburg', 'linz',
    'belgium', 'brussels', 'bruxelles', 'antwerp', 'ghent',
    'france', 'paris', 'lyon', 'marseille', 'toulouse', 'nice',
    'europe', 'eu', 'emea', 'dach', 'remote'
  ];
  const jobLocation = (job.location || '').toLowerCase();
  const isRemoteJob = job.remote || jobLocation.includes('remote') || jobLocation.includes('anywhere');
  const isEULocation = EU_LOCATIONS.some(loc => jobLocation.includes(loc));

  if (!isEULocation && !isRemoteJob && result.letter_grade !== 'F') {
    result.letter_grade = 'F';
    result.weighted_score = 0;
    result.match_percentage = 0;
    result.action = 'Skip';
    result.priority = 'Low';
    result.reason = `Non-EU location rejected: ${job.location || 'Unknown'}`;
  }

  // ============================================
  // STEP 3: Risk Classification (DETERMINISTIC)
  // ============================================
  const highRiskPlatforms = ['linkedin', 'indeed', 'xing'];
  const platformLower = (job.platform || '').toLowerCase();
  const applyTypeLower = (job.apply_type || '').toLowerCase();
  const isEasyApply = applyTypeLower.includes('easy_apply');
  const isHighRiskPlatform = highRiskPlatforms.includes(platformLower);
  result.risk_level = (isHighRiskPlatform || isEasyApply) ? 'High' : 'Low';

  // ============================================
  // STEP 4: Action Decision (Career-Ops thresholds)
  // ============================================
  // A/B (≥3.5) → Apply, C (2.5-3.49) → Review, D/F (<2.5) → Skip
  if (result.weighted_score >= 3.5) {
    result.action = result.risk_level === 'High' ? 'Review' : 'Apply';
  } else if (result.weighted_score >= 2.5) {
    result.action = 'Review';
  } else {
    result.action = 'Skip';
  }

  // ============================================
  // STEP 5: Priority
  // ============================================
  if (result.letter_grade === 'A') {
    result.priority = 'Critical';
  } else if (result.letter_grade === 'B') {
    result.priority = 'High';
  } else if (result.letter_grade === 'C') {
    result.priority = 'Medium';
  } else {
    result.priority = 'Low';
  }

  // ============================================
  // STEP 6: Archetype (use AI result or detect)
  // ============================================
  if (!result.archetype) {
    result.archetype = detectArchetype(job, profile);
  }

  // Enrich with job metadata
  result.job_title = job.title;
  result.company = job.company;
  result.platform = job.platform;
  result.apply_link = job.apply_link;

  return result;
}

function detectArchetype(job, profile) {
  const text = `${job.title} ${job.description || ''}`.toLowerCase();
  const archetypes = profile.archetypes || {};

  let bestMatch = 'Other';
  let bestCount = 0;

  for (const [name, config] of Object.entries(archetypes)) {
    const keywords = (config.keywords || []).map(k => k.toLowerCase());
    const count = keywords.filter(kw => text.includes(kw)).length;
    if (count > bestCount) {
      bestCount = count;
      bestMatch = name.charAt(0).toUpperCase() + name.slice(1);
    }
  }

  return bestMatch;
}
