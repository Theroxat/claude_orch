import { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AuthGate } from './auth';
import { Layout } from './components/Layout';
import { pages } from './routes';
import { PageFallback } from './ui/PageFallback';
import { ToastProvider } from './ui/Toast';

const Login = pages['/login'];
const OAuthConsent = pages['/oauth/consent'];
const Welcome = pages['/welcome'];
const Projects = pages['/projects'];
const Discover = pages['/discover'];
const Pool = pages['/pool'];
const Requests = pages['/requests'];
const Backlog = pages['/backlog'];
const ClaudeCode = pages['/claude-code'];
const MyServer = pages['/my-server'];
const AdminAccess = pages['/admin/access'];

export function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/oauth/consent" element={<OAuthConsent />} />
          <Route element={<AuthGate />}>
            <Route path="/welcome" element={<Welcome />} />
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/projects" replace />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/discover" element={<Discover />} />
              <Route path="/pool" element={<Pool />} />
              <Route path="/requests" element={<Requests />} />
              <Route path="/backlog" element={<Backlog />} />
              <Route path="/claude-code" element={<ClaudeCode />} />
              <Route path="/my-server" element={<MyServer />} />
              <Route path="/admin/access" element={<AdminAccess />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}
