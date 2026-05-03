import { useParams, useNavigate } from "react-router-dom";
import { MessageView } from "../../../views/Chat";

export default function ChatMessagesPage() {
  const { projectId, sessionId } = useParams<{ projectId: string; sessionId: string }>();
  const navigate = useNavigate();

  if (!projectId || !sessionId) return null;

  return (
    <MessageView
      projectId={decodeURIComponent(projectId)}
      projectPath=""
      sessionId={decodeURIComponent(sessionId)}
      summary=""
      onBack={() => navigate(`/history/${projectId}`)}
    />
  );
}
