import {
  ApiUserSchema,
  AgentViewSchema,
  AvailableRepoSchema,
  CreateEnrollmentTokenResponseSchema,
  CreatePersonalTokenResponseSchema,
  PersonalTokenListResponseSchema,
  DiscoverItemSchema,
  ImportTasksResponseSchema,
  InstallUrlResponseSchema,
  TaskBoardSchema,
  TaskViewSchema,
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
export const decideParticipant = (id: string, userId: string, decision: 'approve' | 'reject') =>
  api('POST', `/projects/${id}/participants/${userId}/${decision}`, {
    schema: ParticipationViewSchema,
  });

export const createEnrollmentToken = () =>
  api('POST', '/agents/enrollment-tokens', { schema: CreateEnrollmentTokenResponseSchema });
export const fetchMyAgents = () => api('GET', '/agents/mine', { schema: z.array(AgentViewSchema) });
export const pauseAgent = (id: string) =>
  api('POST', `/agents/${id}/pause`, { schema: AgentViewSchema });
export const resumeAgent = (id: string) =>
  api('POST', `/agents/${id}/resume`, { schema: AgentViewSchema });
export const revokeAgent = (id: string) => api<unknown>('DELETE', `/agents/${id}`);

export const fetchTaskBoard = (projectId?: string) =>
  api('GET', projectId ? `/projects/${projectId}/tasks` : '/tasks', { schema: TaskBoardSchema });
export const createTask = (projectId: string, body: CreateTaskRequest) =>
  api('POST', `/projects/${projectId}/tasks`, { body, schema: TaskViewSchema });
export const importTasks = (projectId: string) =>
  api('POST', `/projects/${projectId}/tasks/import`, { schema: ImportTasksResponseSchema });
export const approveTask = (id: string) =>
  api('POST', `/tasks/${id}/approve`, { schema: TaskViewSchema });

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
