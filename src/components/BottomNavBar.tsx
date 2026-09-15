import React from "react";
import { LayoutGrid, ListFilter, BookOpen, FlaskConical, BrainCircuit } from "lucide-react";

export type TabType = "floor" | "queue" | "book" | "learning" | "lab";

interface BottomNavBarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  pendingQueueCount: number;
}

export const BottomNavBar: React.FC<BottomNavBarProps> = ({
  activeTab,
  onTabChange,
  pendingQueueCount,
}) => {
  const tabs: { id: TabType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "floor", label: "Floor", icon: LayoutGrid },
    { id: "queue", label: "Queue", icon: ListFilter },
    { id: "book", label: "Book", icon: BookOpen },
    { id: "learning", label: "Learning", icon: BrainCircuit },
    { id: "lab", label: "Lab", icon: FlaskConical },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-[#0a0a0c] border-t border-[#1f1f24] py-2 px-4 select-none">
      <div className="max-w-lg mx-auto grid grid-cols-5 items-center">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`relative flex flex-col items-center justify-center py-1 group cursor-pointer transition-colors ${
                isActive ? "text-white" : "text-stone-500 hover:text-stone-300"
              }`}
            >
              {/* Notification badge / dot for Queue */}
              {tab.id === "queue" && pendingQueueCount > 0 && (
                <span className="absolute top-0 right-1/2 translate-x-3 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#0a0a0c]" />
              )}

              {/* Dot indicator for active learning */}
              {tab.id === "learning" && (
                <span className="absolute -top-1 w-1.5 h-1.5 rounded-full bg-emerald-400/80 animate-pulse" />
              )}

              {/* Dot above Queue tab like in screenshots */}
              {tab.id === "queue" && (
                <span className="w-1.5 h-1.5 rounded-full bg-stone-300 mb-0.5" />
              )}

              <Icon className="w-5 h-5 mb-1 stroke-[1.8]" />
              <span className="text-[11px] font-mono tracking-wide font-normal">
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
