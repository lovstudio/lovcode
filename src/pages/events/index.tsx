import { useNavigate } from "react-router-dom";
import { FeaturedCarousel } from "../../components/home";

export default function EventsPage() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col min-h-full px-6 py-8">
      <div className="max-w-4xl mx-auto w-full">
        <h1 className="font-serif text-3xl text-foreground mb-6 tracking-tight">Events</h1>
        <div className="space-y-4">
          <FeaturedCarousel onOpenAnnualReport={() => navigate("/annual-report-2025")} />
        </div>
      </div>
    </div>
  );
}
