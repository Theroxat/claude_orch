// OAuth consent page and e-mail confirmation page.
export default {
  consent: {
    ariaLabel: 'Authorize application',
    rejected: 'Authorization request rejected',
    title: 'Authorize {client}',
    body: "<strong>{client}</strong> (redirect to <code>{host}</code>) wants to use orch's MCP tools (view the pool, list, submit and take tasks) as <strong>{login}</strong>.",
    warning: 'Only approve if you just started this from Claude Code.',
    approve: 'Approve',
    deny: 'Deny',
  },
  confirmEmail: {
    ariaLabel: 'Confirm e-mail address',
    doneTitle: 'E-mail address confirmed',
    doneBody:
      'orch can now send notifications to <strong>{address}</strong>. Choose which events go there in your notification settings.',
    settings: 'Notification settings',
    title: 'Confirm your e-mail address',
    lede: 'Confirm that you want orch to send you notifications at the address you added to your settings.',
    incomplete: 'This link is incomplete. Use the link from the e-mail.',
    invalid:
      'This link is invalid or has expired. Ask for a new one in your notification settings.',
    confirm: 'Confirm',
  },
} as const;
