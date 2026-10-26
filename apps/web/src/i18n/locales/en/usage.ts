// Usage page: token and run totals, chart, budgets and breakdown tables.
export default {
  title: 'Usage',
  lede: {
    admin:
      'Tokens and task runs across all members: your own runs, plus everything that ran in projects you own. All figures are estimates.',
    own: 'Tokens and task runs you can see: your own runs, plus everything that ran in projects you own. All figures are estimates.',
  },
  na: 'n/a',
  range: {
    label: 'Time range',
    d7: '7 days',
    d30: '30 days',
    d90: '90 days',
    last: 'last {days}',
  },
  loading: 'Loading usage',
  units: {
    k: '{value}k',
    m: '{value}M',
    b: '{value}B',
  },
  tokensTitle: {
    weighted: { one: '{count} weighted token', other: '{count} weighted tokens' },
    raw: { one: '{count} token', other: '{count} tokens' },
  },
  cols: {
    runs: 'Runs',
    failed: 'Failed',
    tokens: 'Tokens',
    day: 'Day',
    task: 'Task',
  },
  runs: {
    succeeded: { one: '{count} succeeded', other: '{count} succeeded' },
    failed: { one: '{count} failed', other: '{count} failed' },
  },
  tiles: {
    tokens: 'Tokens',
    tokensNote: 'weighted, {range}',
    runs: 'Task runs',
    successRate: 'Success rate',
    successRateNone: 'no finished run yet',
    successRateNote: 'of finished runs',
    busiest: 'Busiest budget',
    busiestNone: 'you have no active participation',
  },
  empty: {
    runs: '<strong>No finished runs in the {range}.</strong> Runs show up here once a task succeeds or fails on one of your projects. Try a longer range.',
    range: 'Nothing to show for this range.',
  },
  chart: {
    title: 'Tokens per day',
    total: '{tokens} tokens',
    peak: 'peak {tokens} on {day}',
    nothing: 'nothing recorded in this range',
    readout: { one: '{tokens} tokens, {count} run', other: '{tokens} tokens, {count} runs' },
    aria: {
      one: 'Weighted tokens per day over {count} day. Use the left and right arrow keys to read each day.',
      other:
        'Weighted tokens per day over {count} days. Use the left and right arrow keys to read each day.',
    },
    viewTable: 'View as a table',
    dailyUsage: 'Daily usage',
    tableCaption: 'Weighted tokens and runs per day',
  },
  budget: {
    title: 'Budget in this 5-hour window',
    hint: 'What each project has taken from the share of capacity you gave it.',
    unknown: '{percent}% of capacity, budget unknown',
    used: '{used} of {budget} ({percent}% of capacity)',
    meter: 'Budget used by {name}',
    valueUnknown: 'unknown',
    nearLimit: 'Near limit',
  },
  byProject: {
    title: 'By project',
    caption: 'Usage per project',
    head: 'Project',
  },
  byMember: {
    title: 'By member',
    caption: 'Usage per member',
    head: 'Member',
  },
  top: {
    title: 'Most expensive tasks',
    label: 'Top tasks',
    caption: 'Tasks that used the most tokens',
  },
  split: {
    title: 'Token types',
    hintAdmin: {
      one: 'Raw counts from every agent, personal use included. Kept {count} day.',
      other: 'Raw counts from every agent, personal use included. Kept {count} days.',
    },
    hintOwn: {
      one: 'Raw counts from your agents, personal use included. Kept {count} day.',
      other: 'Raw counts from your agents, personal use included. Kept {count} days.',
    },
    input: 'Input',
    output: 'Output',
    cacheWrite: 'Cache write',
    cacheRead: 'Cache read',
  },
} as const;
