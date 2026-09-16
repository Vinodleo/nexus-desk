const fs = require('fs');
let content = fs.readFileSync('src/components/NexusHeader.tsx', 'utf-8');

// The item interface is:
// export interface TickerTapeItem {
//   symbol: string;
//   price: string;
//   change: string;
//   isPositive: boolean;
// }
// Let's add direction to it.

content = content.replace(
  'isPositive: boolean;',
  'isPositive: boolean;\n  direction?: "up" | "down" | "none";'
);

content = content.replace(
  'isPositive: tc.changePercent >= 0',
  'isPositive: tc.changePercent >= 0,\n    direction: tc.direction'
);

// Add PriceTick component to handle the animation
const priceTickComponent = `
const PriceTick = ({ price, direction }: { price: string, direction?: "up" | "down" | "none" }) => {
  const [flash, setFlash] = React.useState<"up" | "down" | "none">("none");
  
  React.useEffect(() => {
    if (direction && direction !== "none") {
      setFlash(direction);
      const t = setTimeout(() => setFlash("none"), 300);
      return () => clearTimeout(t);
    }
  }, [price, direction]);

  return (
    <span className={\`transition-colors duration-300 rounded px-0.5 \${
      flash === "up" ? "bg-emerald-500/30 text-emerald-300" :
      flash === "down" ? "bg-rose-500/30 text-rose-300" :
      "text-stone-200"
    }\`}>
      {price}
    </span>
  );
};
`;

if (!content.includes('const PriceTick')) {
  content = content.replace('export const NexusHeader: React.FC<NexusHeaderProps> =', priceTickComponent + '\nexport const NexusHeader: React.FC<NexusHeaderProps> =');
}

// Replace the price rendering
content = content.replace(
  '<span className="text-stone-200">{item.price}</span>',
  '<PriceTick price={item.price} direction={item.direction} />'
);

fs.writeFileSync('src/components/NexusHeader.tsx', content);
console.log("Patched Header");
