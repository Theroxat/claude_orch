import {
  ApiUserSchema,
  AgentViewSchema,
  AvailableRepoSchema,
  CreateEnrollmentTokenResponseSchema,
  CreatePersonalTokenResponseSchema,
  OutdatedCountResponseSchema,
  PersonalTokenListResponseSchema,
  DiscoverItemSchema,
  HistoryResponseSchema,
  ImportTasksResponseSchema,
  InstallUrlResponseSchema,
  TaskBoardSchema,
  TaskViewSchema,
  WhyNotRunningResponseSchema,
  OfferListResponseSchema,
  OnboardingResponseSchema,
  OfferViewSchema,
  ParticipantItemSchema,
  PoolResponseSchema,
  ParticipationViewSchema,
  ProjectViewSchema,
  type AddProjectRequest,
  type CreatePersonalTokenRequest,
  type CreateTaskRequest,
  type UpdateProjectRequest,
  type UndoRejectionRequest,
  type UpsertParticipationRequest,
} from '@orch/shared';
import { z } from 'zod';
import { api } from './client';

export const fetchMe = () => api('GET', '/me', { schema: ApiUserSchema });
export const fetchInstallUrl = () =>
  api('GET', '/github/install-url', { schema: InstallUrlResponseSchema });
export const fetchAvailableRepos = () =>
  api('GET', '/repos/available', { schema: z.array(AvailableRepoSchema) });
export const fetchMyProjects = () =>
  api('GET', '/projects/mine', { schema: z.array(ProjectViewSchema) });
export const addProject = (body: AddProjectRequest) =>
  api('POST', '/projects', { body, schema: ProjectViewSchema });
export const updateProject = (id: string, body: UpdateProjectRequest) =>
  api('PATCH', `/projects/${id}`, { body, schema: ProjectViewSchema });
export const deleteProject = (id: string) => api<unknown>('DELETE', `/projects/${id}`);
export const fetchDiscover = () =>
  api('GET', '/projects/discover', { schema: z.array(DiscoverItemSchema) });
export const putParticipation = (id: string, body: UpsertParticipationRequest) =>
  api('PUT', `/projects/${id}/participation`, { body, schema: ParticipationViewSchema });
export const fetchParticipants = (id: string) =>
  api('GET', `/projects/${id}/participants`, { schema: z.array(ParticipantItemSchema) });
export const decideParticipant = (
  id: string,
  userId: string,
  decision: 'approve' | 'reject',
  reason?: string,
) =>
  api('POST', `/projects/${id}/participants/${userId}/${decision}`, {
    ...(decision === 'reject' && reason ? { body: { reason } } : {}),
    schema: ParticipationViewSchema,
  });
export const undoRejection = (id: string, userId: string, body: UndoRejectionRequest) =>
  api('POST', `/projects/${id}/participants/${userId}/undo-rejection`, {
    body,
    schema: ParticipationViewSchema,
  });

export const createEnrollmentToken = () =>
  api('POST', '/agents/enrollment-tokens', { schema: CreateEnrollmentTokenResponseSchema });
export const fetchMyAgents = () => api('GET', '/agents/mine', { schema: z.array(AgentViewSchema) });
export const pauseAgent = (id: string) =>
  api('POST', `/agents/${id}/pause`, { schema: AgentViewSchema });
export const resumeAgent = (id: string) =>
  api('POST', `/agents/${id}/resume`, { schema: AgentViewSchema });
export const fetchOutdatedCount = () =>
  api('GET', '/agents/outdated-count', { schema: OutdatedCountResponseSchema });
export const updateAgent = (id: string, whenIdle = false) =>
  api('POST', `/agents/${id}/update`, { body: { whenIdle }, schema: AgentViewSchema });
export const revokeAgent = (id: string) => api<unknown>('DELETE', `/agents/${id}`);

export const fetchTaskBoard = (projectId?: string) =>
  api('GET', projectId ? `/projects/${projectId}/tasks` : '/tasks', { schema: TaskBoardSchema });
export const createTask = (projectId: string, body: CreateTaskRequest) =>
  api('POST', `/projects/${projectId}/tasks`, { body, schema: TaskViewSchema });
export const importTasks = (projectId: string) =>
  api('POST', `/projects/${projectId}/tasks/import`, { schema: ImportTasksResponseSchema });
export const approveTask = (id: string) =>
  api('POST', `/tasks/${id}/approve`, { schema: TaskViewSchema });

export const retryTask = (id: string) =>
  api('POST', `/tasks/${id}/retry`, { schema: TaskViewSchema });
export const fetchWhyNotRunning = (id: string) =>
  api('GET', `/tasks/${id}/why-not-running`, { schema: WhyNotRunningResponseSchema });

export const fetchPool = (projectId?: string) =>
  api('GET', projectId ? `/pool?projectId=${encodeURIComponent(projectId)}` : '/pool', {
    schema: PoolResponseSchema,
  });
export const fetchMyOffers = () => api('GET', '/offers/mine', { schema: OfferListResponseSchema });
export const acceptOffer = (id: string) =>
  api('POST', `/offers/${id}/accept`, { schema: OfferViewSchema });
export const rejectOffer = (id: string) =>
  api('POST', `/offers/${id}/reject`, { schema: OfferViewSchema });

export const fetchTokens = () => api('GET', '/tokens', { schema: PersonalTokenListResponseSchema });
export const createToken = (body: CreatePersonalTokenRequest) =>
  api('POST', '/tokens', { body, schema: CreatePersonalTokenResponseSchema });
export const revokeToken = (id: string) => api<unknown>('DELETE', `/tokens/${id}`);

export const fetchOnboarding = () =>
  api('GET', '/onboarding', { schema: OnboardingResponseSchema });

export const completeOnboarding = () =>
  api('POST', '/onboarding/complete', { schema: ApiUserSchema });
export const dismissOnboarding = () =>
  api('POST', '/onboarding/dismiss', { schema: ApiUserSchema });

const GrantSchema = z.object({
  id: z.string(),
  githubLogin: z.string(),
  githubUserId: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: z.enum(['PENDING', 'APPROVED', 'DENIED']),
  note: z.string().nullable(),
  requestedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});
const InviteSchema = z.object({
  id: z.string(),
  multiUse: z.boolean(),
  expiresAt: z.string(),
  uses: z.number(),
  revokedAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  active: z.boolean(),
});
const AccessSchema = z.object({
  pending: z.array(GrantSchema),
  approved: z.array(GrantSchema),
  denied: z.array(GrantSchema),
  invites: z.array(InviteSchema),
  configured: z.object({
    logins: z.array(z.string()),
    orgs: z.array(z.string()),
    admins: z.array(z.string()),
    allowAny: z.boolean(),
  }),
});
export type AccessGrant = z.infer<typeof GrantSchema>;
export type AccessInvite = z.infer<typeof InviteSchema>;

export const fetchAccess = () => api('GET', '/admin/access', { schema: AccessSchema });
export const fetchPendingCount = () =>
  api('GET', '/admin/access/pending-count', { schema: z.object({ count: z.number() }) });
const GrantResp = z.object({ grant: GrantSchema });
export const preApprove = (githubLogin: string) =>
  api('POST', '/admin/access/grants', { body: { githubLogin }, schema: GrantResp });
export const decideGrant = (id: string, action: 'approve' | 'deny' | 'remove') =>
  api('POST', `/admin/access/grants/${id}/${action}`, { schema: GrantResp });
export const createInvite = (body: { multiUse: boolean; expiresInHours: number }) =>
  api('POST', '/admin/access/invites', {
    body,
    schema: z.object({ invite: InviteSchema, url: z.string() }),
  });
export const revokeInvite = (id: string) =>
  api('POST', `/admin/access/invites/${id}/revoke`, {
    schema: z.object({ invite: InviteSchema }),
  });

/** One page of the task history; `params` is the filter query string (cursor excluded). */
export const fetchHistory = (params: URLSearchParams, cursor?: string) => {
  const qs = new URLSearchParams(params);
  if (cursor) qs.set('cursor', cursor);
  const text = qs.toString();
  return api('GET', `/tasks/history${text ? `?${text}` : ''}`, { schema: HistoryResponseSchema });
};
