import { MaasRegistryView } from "../../views/Settings";
import { FeaturesLayout } from "../../views/Features";

export default function MaasRegistryPage() {
  return (
    <FeaturesLayout feature="basic-maas">
      <MaasRegistryView />
    </FeaturesLayout>
  );
}
