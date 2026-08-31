import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { isAuthenticated } from './lib/auth';
import { I18nProvider } from './i18n';
import Layout from './components/Layout';
import Login from './pages/Login';
import Items from './pages/Items';
import ItemDetail from './pages/ItemDetail';
import ErrorGroups from './pages/ErrorGroups';
import Projects from './pages/Projects';
import ProjectIntegrations from './pages/ProjectIntegrations';
import Users from './pages/Users';
import Webhooks from './pages/Webhooks';

function AuthGuard({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <I18nProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/*"
            element={
              <AuthGuard>
                <Layout />
              </AuthGuard>
            }
          >
            <Route index element={<Navigate to="/items" replace />} />
            <Route path="items" element={<Items />} />
            <Route path="improvements" element={<Items scope="improvements" />} />
            <Route path="items/:id" element={<ItemDetail />} />
            <Route path="errors" element={<ErrorGroups />} />
            <Route path="projects" element={<Projects />} />
            <Route path="projects/:id/integrations" element={<ProjectIntegrations />} />
            <Route path="webhooks" element={<Webhooks />} />
            <Route path="users" element={<Users />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </I18nProvider>
  );
}
