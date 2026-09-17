const fs = require('fs');
let content = fs.readFileSync('src/components/BottomNavBar.tsx', 'utf-8');

// add LineChart to imports
content = content.replace(/import \{([^}]+)\} from "lucide-react";/, 'import { $1, LineChart } from "lucide-react";');
// add chart to TabType
content = content.replace(/export type TabType = "floor" \| "queue" \| "book" \| "learning" \| "lab";/, 'export type TabType = "floor" | "queue" | "book" | "learning" | "lab" | "chart";');
// add tab
content = content.replace(/\{ id: "lab", label: "Lab", icon: FlaskConical \},/, '{ id: "chart", label: "Chart", icon: LineChart },\n    { id: "lab", label: "Lab", icon: FlaskConical },');
// change grid cols to 6
content = content.replace(/grid-cols-5/, 'grid-cols-6');

fs.writeFileSync('src/components/BottomNavBar.tsx', content);
