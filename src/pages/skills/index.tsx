import { useNavigate } from "react-router-dom";
import { SkillsView } from "../../views/Skills";
import { FeaturesLayout } from "../../views/Features";

export default function SkillsPage() {
  const navigate = useNavigate();

  return (
    <FeaturesLayout feature="skills">
      <SkillsView
        onSelectTemplate={(template) => {
          navigate(`/skills/${encodeURIComponent(template.name)}`);
        }}
        onMarketplaceSelect={(template) => {
          navigate(`/skills/${encodeURIComponent(template.name)}?source=marketplace`);
        }}
      />
    </FeaturesLayout>
  );
}
