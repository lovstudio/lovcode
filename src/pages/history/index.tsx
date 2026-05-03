import { useNavigate } from "react-router-dom";
import { ProjectList } from "../../views/Chat";

export default function ChatProjectsPage() {
  const navigate = useNavigate();

  return (
    <ProjectList
      onSelectProject={(p) => navigate(`/history/${encodeURIComponent(p.id)}`)}
      onSelectSession={(s) => navigate(`/history/${encodeURIComponent(s.project_id)}/${encodeURIComponent(s.id)}`)}
      onSelectChat={(c) => navigate(`/history/${encodeURIComponent(c.project_id)}/${encodeURIComponent(c.session_id)}`)}
    />
  );
}
