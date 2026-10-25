// Strings shared across the app: generic actions, time, errors.
export default {
  actions: {
    cancel: 'Cancel',
    close: 'Close',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    retry: 'Try again',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    loadMore: 'Load more',
  },
  status: {
    loading: 'Loading…',
    loadingPage: 'Loading page',
    saving: 'Saving…',
  },
  time: {
    now: 'now',
    in: 'in {duration}',
    ago: '{duration} ago',
    hoursMinutes: '{h}h {m}m',
    minutes: '{m}m',
    expired: 'expired',
  },
  toast: {
    rateLimitedFor: 'Too many requests. Please wait {seconds} s and try again.',
    rateLimited: 'Too many requests. Please wait a moment and try again.',
  },
} as const;
