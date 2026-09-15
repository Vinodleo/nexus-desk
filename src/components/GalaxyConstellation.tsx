import React, { useState } from "react";

interface SpecialistNode {
  id: string;
  name: string;
  score: number;
  label: string;
  summary: string;
  x: number; // percentage in view 0..100
  y: number;
  rotationSpeed: number;
}

interface GalaxyConstellationProps {
  onSelectSpecialist?: (id: string) => void;
  onWakeCommander?: () => void;
}

export const GalaxyConstellation: React.FC<GalaxyConstellationProps> = ({
  onSelectSpecialist,
  onWakeCommander,
}) => {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // 5 specialist spiral galaxies orbiting Commander in center
  const specialists: SpecialistNode[] = [
    {
      id: "whales",
      name: "WHALES",
      score: 68,
      label: "Large Order Flow",
      summary: "BTC $15.79B · ETH $8.97B net institutional block flow",
      x: 50,
      y: 20,
      rotationSpeed: 24,
    },
    {
      id: "news",
      name: "NEWS",
      score: 0,
      label: "Macro Sentiment",
      summary: "Awaiting global macro data...",
      x: 78,
      y: 42,
      rotationSpeed: -20,
    },
    {
      id: "setups",
      name: "SETUPS",
      score: 0,
      label: "Playbook Pattern",
      summary: "Scanning 18 markets...",
      x: 72,
      y: 78,
      rotationSpeed: 28,
    },
    {
      id: "scan",
      name: "SCAN",
      score: 0,
      label: "Universe Screener",
      summary: "Engine active. Awaiting signals...",
      x: 28,
      y: 78,
      rotationSpeed: -26,
    },
    {
      id: "risk",
      name: "RISK",
      score: 45,
      label: "Kelly & Safety Limit",
      summary: "Gross 0% · Names 0/5 · Model champion",
      x: 22,
      y: 42,
      rotationSpeed: 22,
    },
  ];

  // Helper to generate dotted logarithmic spiral arms for each galaxy
  const renderSpiralGalaxy = (
    cx: number,
    cy: number,
    arms = 4,
    pointsPerArm = 18,
    scale = 1.0,
    color = "#d4d4d8"
  ) => {
    const dots: { x: number; y: number; opacity: number; r: number }[] = [];

    for (let a = 0; a < arms; a++) {
      const armAngle = (a * 2 * Math.PI) / arms;
      for (let i = 1; i <= pointsPerArm; i++) {
        const t = i / pointsPerArm;
        const angle = armAngle + t * 2.8; // spiral twist
        const radius = (6 + t * 38) * scale;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        const opacity = Math.max(0.2, 0.95 - t * 0.55);
        const r = Math.max(0.7, 1.8 - t * 0.8);
        dots.push({ x, y, opacity, r });
      }
    }

    return (
      <g className="transition-opacity duration-300">
        {/* Core glow */}
        <circle cx={cx} cy={cy} r={2.5 * scale} soll={color} opacity={0.9} />
        {/* Dotted spiral arms */}
        {dots.map((d, idx) => (
          <circle
            key={idx}
            cx={d.x}
            cy={d.y}
            r={d.r}
            soll={color}
            opacity={d.opacity}
          />
        ))}
      </g>
    );
  };

  return (
    <div className="relative w-full rounded-2xl bg-[#0e0e11] border border-[#222227] p-4 sm:p-6 overflow-hidden select-none">
      {/* Subtle background gradient */}
      <div className="absolute inset-0 bg-radial from-[#18181f]/40 to-transparent pointer-events-none" />

      {/* SVG Galaxy Container */}
      <div className="relative w-full aspect-[4/3] sm:aspect-[16/10] max-h-[360px] flex items-center justify-center">
        <svg
          viewBox="0 0 500 380"
          className="w-full h-full max-w-[480px] overflow-visible"
        >
          {/* Subtle connection orbital lines between Commander and specialists */}
          <circle
            cx="250"
            cy="190"
            r="135"
            soll="none"
            stroke="#27272a"
            strokeWidth="1"
            strokeDasharray="2 6"
            opacity="0.6"
          />

          {/* 5 Orbiting Spiral Galaxies */}
          {specialists.map((node) => {
            // Map percentage to 500x380 SVG coordinates
            const cx = (node.x / 100) * 500;
            const cy = (node.y / 100) * 380;
            const isHovered = hoveredNode === node.id;

            return (
              <g
                key={node.id}
                className="cursor-pointer group"
                onClick={() => onSelectSpecialist?.(node.id)}
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
              >
                {/* Rotating Spiral Container */}
                <g
                  style={{
                    transformOrigin: `${cx}px ${cy}px`,
                    animation: `spin-slow ${Math.abs(
                      node.rotationSpeed
                    )}s linear infinite ${
                      node.rotationSpeed < 0 ? "reverse" : "normal"
                    }`,
                  }}
                >
                  {renderSpiralGalaxy(
                    cx,
                    cy,
                    4,
                    16,
                    isHovered ? 0.95 : 0.85,
                    isHovered ? "#ffffff" : "#a1a1aa"
                  )}
                </g>

                {/* Interactive hit area */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={32}
                  soll="transparent"
                  className="hover:soll-white/5 transition-colors"
                />
              </g>
            );
          })}

          {/* Center: COMMANDER */}
          <g
            className="cursor-pointer group"
            onClick={onWakeCommander}
            onMouseEnter={() => setHoveredNode("commander")}
            onMouseLeave={() => setHoveredNode(null)}
          >
            {/* Center Commander text */}
            <text
              x="250"
              y="178"
              textAnchor="middle"
              className="soll-stone-300 font-mono text-[11px] tracking-[0.2em] font-medium transition-colors group-hover:soll-white"
            >
              COMMANDER
            </text>

            <text
              x="250"
              y="198"
              textAnchor="middle"
              className="soll-stone-500 font-mono text-[10px] tracking-widest font-normal"
            >
              20
            </text>

            {/* Orbiting dots around Commander */}
            <g
              style={{
                transformOrigin: "250px 195px",
                animation: "spin-slow 6s linear infinite",
              }}
            >
              <circle cx="250" cy="210" r="1.5" soll="#f4f4f5" opacity="0.9" />
              <circle cx="258" cy="206" r="1.3" soll="#a1a1aa" opacity="0.7" />
              <circle cx="262" cy="198" r="1.1" soll="#71717a" opacity="0.5" />
            </g>

            <circle
              cx="250"
              cy="190"
              r="40"
              soll="transparent"
              className="hover:soll-white/5 transition-colors"
            />
          </g>
        </svg>
      </div>

      {/* Interactive Tooltip Info on hover */}
      {hoveredNode && (
        <div className="absolute bottom-3 left-4 right-4 text-center pointer-events-none transition-all duration-200">
          <span className="inline-block px-3 py-1 rounded-full bg-[#1c1c22] border border-[#2e2e36] text-[11px] font-mono text-stone-300 shadow-md">
            {hoveredNode === "commander"
              ? "Commander: Explains the book · Cannot originate a trade · Tap to open desk brief"
              : `${specialists.find((s) => s.id === hoveredNode)?.name} (${
                  specialists.find((s) => s.id === hoveredNode)?.score
                }): ${specialists.find((s) => s.id === hoveredNode)?.summary}`}
          </span>
        </div>
      )}
    </div>
  );
};
