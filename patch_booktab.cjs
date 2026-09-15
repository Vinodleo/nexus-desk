const fs = require('fs');
let code = fs.readFileSync('src/components/BookTab.tsx', 'utf-8');

code = code.replace(
  'import { Position, HistoricalTrade } from "../types";',
  'import { Position, HistoricalTrade } from "../types";\nimport { TradeAutopsyCard } from "./TradeAutopsyCard";'
);

code = code.replace(
  '                        </div>\n                      </div>\n                    </div>\n                  </div>',
  '                        </div>\n                      </div>\n                    </div>\n                    <TradeAutopsyCard trade={trade} onUpdateTrade={onUpdateTrade} />\n                  </div>'
);

fs.writeFileSync('src/components/BookTab.tsx', code);
