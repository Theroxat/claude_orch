// Admin access page: pending requests, members, invite links and server configuration.
export default {
  title: 'Access',
  lede: 'Decide who may sign in to this orch server: answer requests, pre-approve logins and send invite links.',
  adminsOnly: 'Admins only.',
  actions: {
    approve: 'Approve',
    deny: 'Deny',
    remove: 'Remove',
    revoke: 'Revoke',
    preApprove: 'Pre-approve',
    createInvite: 'Create invite link',
  },
  pending: {
    title: 'Pending requests',
    none: 'No pending requests.',
  },
  members: {
    title: 'Members',
    none: 'No approved members yet.',
    approvedBy: 'approved by {name}',
    addLogin: 'Add a GitHub login',
    confirmRemove:
      'Remove {login}? This denies their access to the server until an admin approves them again.',
  },
  invites: {
    title: 'Invite links',
    none: 'No invite links.',
    type: 'Type',
    singleUse: 'Single-use',
    multiUse: 'Multi-use',
    expiresAfter: 'Expires after',
    expiry: {
      h24: '24 hours',
      h168: '7 days',
      h720: '30 days',
    },
    notShownAgain: "This link won't be shown again. Copy it now.",
    usesExpires: {
      one: '{count} use, expires {date}',
      other: '{count} uses, expires {date}',
    },
    status: {
      revoked: 'revoked',
      expired: 'expired',
      used: 'used',
      active: 'active',
      inactive: 'inactive',
    },
  },
  configured: {
    title: 'Configured on the server',
    hint: 'These entries are configured on the server (environment) and cannot be changed here.',
    allowAny: 'Any GitHub account is allowed on this server.',
    logins: 'Logins',
    orgs: 'Organizations',
    admins: 'Admins',
    none: 'none',
  },
  declined: 'Declined ({count})',
  toast: {
    approved: '{login} approved',
    denied: '{login} denied',
    removed: '{login} removed',
    preApproved: '{login} pre-approved',
    inviteRevoked: 'Invite link revoked',
  },
} as const;
