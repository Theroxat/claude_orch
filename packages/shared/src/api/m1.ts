/**
 * M1 REST contract (JSON, cookie session, every route under /api).
 * Server validates requests and the web client may validate responses with these schemas.
 *
 * Routes:
 *   GET    /api/auth/github/login                           302 to GitHub OAuth
 *   GET    /api/auth/github/callback                        sets session cookie, 302 to "/"
 *   POST   /api/auth/logout                                 204
 *   GET    /api/me                                          ApiUser (with isAdmin) | 401
 *   GET    /api/github/install-url                          InstallUrlResponse
 *   GET    /api/repos/available                             AvailableRepo[]
 *   POST   /api/projects                 AddProjectRequest  -> ProjectView (201)
 *   GET    /api/projects/mine                               ProjectView[]
 *   PATCH  /api/projects/:id             UpdateProjectRequest -> ProjectView   (owner only)
 *   DELETE /api/projects/:id                                204                  (owner only)
 *   GET    /api/projects/discover                           DiscoverItem[]
 *   PUT    /api/projects/:id/participation UpsertParticipationRequest -> ParticipationView
 *   GET    /api/projects/:id/participants                   ParticipantItem[]    (owner only)
 *   POST   /api/projects/:id/participants/:userId/approve   ParticipationView    (owner only)
 *   POST   /api/projects/:id/participants/:userId/reject    ParticipationView    (owner only)
 *
 * Errors: HTTP status + `{ error: { code, message } }`.
 */
import { z } from 'zod';
import { Policy, Visibility } from '../domain/enums';

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiUserSchema = z.object({
  id: z.string(),
  githubLogin: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** Setup wizard state, stored server-side (ISO timestamps). Absent = not set. */
  onboardingCompletedAt: z.string().nullish(),
  onboardingDismissedAt: z.string().nullish(),
  /** ORCH_ADMIN_GITHUB_LOGINS member: may manage access on the Access page (/admin/access). */
  isAdmin: z.boolean().default(false),
});
export type ApiUser = z.infer<typeof ApiUserSchema>;

export const InstallUrlResponseSchema = z.object({ url: z.url() });
export type InstallUrlResponse = z.infer<typeof InstallUrlResponseSchema>;

export const AvailableRepoSchema = z.object({
  githubRepoId: z.number().int(),
  fullName: z.string(),
  private: z.boolean(),
  installationId: z.number().int(),
  alreadyAdded: z.boolean(),
});
export type AvailableRepo = z.infer<typeof AvailableRepoSchema>;

export const ProjectViewSchema = z.object({
  id: z.string(),
  githubRepoId: z.number().int(),
  fullName: z.string(),
  isPrivate: z.boolean(),
  defaultBranch: z.string(),
  /** Who sees it in Discover. */
  visibility: Visibility,
  requireParticipantApproval: z.boolean(),
  whoCanParticipate: Policy,
  /** GITHUB (write or more) or ALLOWLIST. */
  whoCanSubmit: z.enum(['GITHUB', 'ALLOWLIST']),
  ownerId: z.string(),
  createdAt: z.string(),
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const AddProjectRequestSchema = z.object({ githubRepoId: z.number().int().positive() });
export type AddProjectRequest = z.infer<typeof AddProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .object({
    visibility: Visibility,
    requireParticipantApproval: z.boolean(),
    whoCanParticipate: Policy,
    whoCanSubmit: z.enum(['GITHUB', 'ALLOWLIST']),
  })
  .partial();
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ApiParticipationMode = z.enum(['auto', 'approval']);
export type ApiParticipationMode = z.infer<typeof ApiParticipationMode>;

/**
 * inactive: the member is not participating. pending: wants in, waiting for the owner.
 * active: eligible for work. rejected: the owner rejected the request.
 */
export const ParticipationStatus = z.enum(['inactive', 'pending', 'active', 'rejected']);
export type ParticipationStatus = z.infer<typeof ParticipationStatus>;

export const ParticipationViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  participating: z.boolean(),
  budgetPercent: z.number().int().min(0).max(100),
  mode: ApiParticipationMode,
  status: ParticipationStatus,
  approvedAt: z.string().nullable(),
});
export type ParticipationView = z.infer<typeof ParticipationViewSchema>;

export const UpsertParticipationRequestSchema = z.object({
  participating: z.boolean(),
  budgetPercent: z.number().int().min(0).max(100),
  mode: ApiParticipationMode,
});
export type UpsertParticipationRequest = z.infer<typeof UpsertParticipationRequestSchema>;

export const MyRole = z.enum(['owner', 'submitter', 'proposer', 'none']);
export type MyRole = z.infer<typeof MyRole>;

export const DiscoverItemSchema = z.object({
  project: ProjectViewSchema,
  owner: z.object({ githubLogin: z.string(), avatarUrl: z.string().nullable() }),
  myRole: MyRole,
  myParticipation: ParticipationViewSchema.nullable(),
  /** Additive: false when the project's policy forbids this user from participating. */
  canParticipate: z.boolean().default(true),
  /** Additive: why `canParticipate` is false (`NOT_GITHUB_COLLABORATOR`, `NOT_ON_ALLOWLIST`). */
  cannotParticipateReason: z.string().nullable().default(null),
});
export type DiscoverItem = z.infer<typeof DiscoverItemSchema>;

export const ParticipantItemSchema = z.object({
  user: ApiUserSchema,
  participation: ParticipationViewSchema,
});
export type ParticipantItem = z.infer<typeof ParticipantItemSchema>;
