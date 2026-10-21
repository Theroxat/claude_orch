import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './auth';
import { Layout } from './components/Layout';
import { AdminAccess } from './pages/AdminAccess';
import { Backlog } from './pages/Backlog';
import { ClaudeCode } from './pages/ClaudeCode';
import { Discover } from './pages/Discover';
import { Login } from './pages/Login';
import { OAuthConsent } from './pages/OAuthConsent';
import { MyServer } from './pages/MyServer';
import { Pool } from './pages/Pool';
import { Projects } from './pages/Projects';
import { Requests } from './pages/Requests';
import { Welcome } from './pages/Welcome';

export function App() {
  return (
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
  );
}
