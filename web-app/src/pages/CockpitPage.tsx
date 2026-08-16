import { useParams, useNavigate } from 'react-router-dom';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ExecutionCockpit } from '../cockpit/ExecutionCockpit';

export default function CockpitPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  if (!sessionId) {
    return (
      <div className="flex h-screen items-center justify-center bg-background dark:bg-dark-bg">
        <p className="text-caption text-danger">No session specified.</p>
      </div>
    );
  }

  return (
    <div className="h-screen bg-background dark:bg-dark-bg">
      <ErrorBoundary name="ExecutionCockpit">
        <ExecutionCockpit
          sessionId={sessionId}
          onClose={() => navigate(`/project/${sessionId}`)}
        />
      </ErrorBoundary>
    </div>
  );
}
