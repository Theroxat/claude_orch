import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './auth';
import { Layout } from './components/Layout';
import { Backlog } from './pages/Backlog';
import { Discover } from './pages/Discover';
import { Login } from './pages/Login';
import { MyServer } from './pages/MyServer';
import { Pool } from './pages/Pool';
import { Projects } from './pages/Projects';
import { Requests } from './pages/Requests';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AuthGate />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/pool" element={<Pool />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/backlog" element={<Backlog />} />
          <Route path="/my-server" element={<MyServer />} />
        </Route>
      </Route>
    </Routes>
  );
}
