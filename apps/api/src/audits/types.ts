export type Intent = 'category' | 'comparison' | 'problem' | 'brand';

/** How many times each audit prompt is asked on each engine. Kept low: an audit is a snapshot for a sales conversation. */
export const AUDIT_SAMPLES = 1;
/** Prompts an audit may ask. */
export const AUDIT_MAX_PROMPTS = 15;
export const AUDIT_MAX_COMPETITORS = 3;
