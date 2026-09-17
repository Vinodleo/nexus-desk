const fs = require('fs');
let content = fs.readFileSync('src/components/ChartTab.tsx', 'utf-8');
content = content.replace(/<TradingViewStage[\s\S]*?\/>/, `<TradingViewStage
          bars={bars}
          currentSymbol={selectedSymbol}
          onSymbolChange={setSelectedSymbol}
          orderBook={{
            bids: [{ price: 0, size: 0, total: 0 }],
            asks: [{ price: 0, size: 0, total: 0 }],
            spread: 0,
            midPrice: 0,
          }}
          regime="trending_bullish"
          isPlaying={true}
          onTogglePlay={() => {}}
          onStepForward={() => {}}
          onFastForward={() => {}}
          onReset={() => {}}
          onTriggerAnalysis={() => {}}
          activeProposal={null}
          activeSetups={[]}
          isAnalyzing={false}
        />`);
fs.writeFileSync('src/components/ChartTab.tsx', content);
