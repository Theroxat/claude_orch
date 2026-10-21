import { z } from 'zod';

export const GithubRole = z.enum(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', 'NONE']);
export type GithubRole = z.infer<typeof GithubRole>;

export const Visibility = z.enum(['ALL_MEMBERS', 'COLLABORATORS', 'ALLOWLIST']);
export type Visibility = z.infer<typeof Visibility>;

export const Policy = z.enum(['GITHUB', 'ALLOWLIST', 'ALL_MEMBERS']);
export type Policy = z.infer<typeof Policy>;

export const ParticipationMode = z.enum(['AUTO', 'APPROVAL']);
export type ParticipationMode = z.infer<typeof ParticipationMode>;

export const Model = z.enum(['SONNET', 'OPUS']);
export type Model = z.infer<typeof Model>;
