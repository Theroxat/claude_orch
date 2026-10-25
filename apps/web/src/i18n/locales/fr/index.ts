import type en from '../en/index.ts';
import type { Catalog } from '../../types.ts';
import common from './common.ts';
import errors from './errors.ts';
import login from './login.ts';
import layout from './layout.ts';
import auth from './auth.ts';
import welcome from './welcome.ts';
import projects from './projects.ts';
import pool from './pool.ts';
import backlog from './backlog.ts';
import templates from './templates.ts';
import history from './history.ts';
import usage from './usage.ts';
import server from './server.ts';
import claudeCode from './claudeCode.ts';
import admin from './admin.ts';
import notifications from './notifications.ts';

const fr = {
  common,
  errors,
  login,
  layout,
  auth,
  welcome,
  projects,
  pool,
  backlog,
  templates,
  history,
  usage,
  server,
  claudeCode,
  admin,
  notifications,
} satisfies Catalog<typeof en>;

export default fr;
