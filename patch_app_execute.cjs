const fs = require('fs');
let appContent = fs.readFileSync('src/App.tsx', 'utf-8');

const oldApprove = `  const handleApproveProposal = useCallback(
    (proposal: TradeProposal, isAutonomousSelfApproved: boolean = false) => {
      if (userRole === "auditor") {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Security Clearance Restricted",
          message:
            "Auditor clearance is read-only. Switch to Desk Trader or Commander to approve orders.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      if (killSwitchActive) {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Kill Switch Active",
          message:
            "Emergency stop is engaged. Cannot open new positions while kill switch is active.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      const activeForSymbol = activePositions.filter(
        (p) => p.symbol === proposal.symbol
      ).length;
      if (activeForSymbol >= 1) {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Position Limit Reached",
          message: \`Already have an active position for \${proposal.symbol}.\`,
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        handleRejectProposal(proposal.id, "Position limit reached");
        return;
      }

      const requiredMargin = proposal.confidence * 10000;
      if (cash < requiredMargin) {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Insufficient Margin",
          message: \`Required: $\${requiredMargin.toFixed(
            2
          )}. Available: $\${cash.toFixed(2)}\`,
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        handleRejectProposal(proposal.id, "Insufficient Margin");
        return;
      }

      setProposalQueue((prev) => prev.filter((p) => p.id !== proposal.id));

      const newPosition: Position = {
        id: \`POS-\${Date.now()}\`,
        symbol: proposal.symbol,
        direction: proposal.direction,
        entryPrice: proposal.currentPrice,
        quantity: requiredMargin / proposal.currentPrice,
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
        status: "OPEN",
        setup: proposal.setup,
        confidence: proposal.confidence,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        timestamp: Date.now(),
      };

      setActivePositions((prev) => [...prev, newPosition]);
      setCash((prev) => prev - requiredMargin);

      logSecurityAudit(
        isAutonomousSelfApproved ? "AUTONOMOUS_EXECUTION" : "ORDER_EXECUTED",
        \`Opened \${proposal.direction} \${proposal.symbol} @ \${proposal.currentPrice}\`
      );

      // Play execute sound
      try {
        const audio = new Audio("/sounds/execute.wav");
        audio.volume = 0.4;
        audio.play().catch(() => {});
      } catch (e) {}

      setExecutionToast({
        id: \`toast-\${Date.now()}\`,
        title: "Order Executed",
        message: \`Successfully entered \${proposal.direction} \${proposal.symbol} at \${proposal.currentPrice}\`,
        type: "SUCCESS",
        timestamp: new Date().toLocaleTimeString(),
      });
    },
    [userRole, activePositions, cash, killSwitchActive]
  );`;

const newApprove = `  const handleApproveProposal = useCallback(
    async (proposal: TradeProposal, isAutonomousSelfApproved: boolean = false) => {
      if (userRole === "auditor") {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Security Clearance Restricted",
          message:
            "Auditor clearance is read-only. Switch to Desk Trader or Commander to approve orders.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      if (killSwitchActive) {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Kill Switch Active",
          message:
            "Emergency stop is engaged. Cannot open new positions while kill switch is active.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      const activeForSymbol = activePositions.filter(
        (p) => p.symbol === proposal.symbol
      ).length;
      if (activeForSymbol >= 1) {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Position Limit Reached",
          message: \`Already have an active position for \${proposal.symbol}.\`,
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        handleRejectProposal(proposal.id, "Position limit reached");
        return;
      }

      const requiredMargin = proposal.confidence * 10000;
      if (cash < requiredMargin) {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Insufficient Margin",
          message: \`Required: $\${requiredMargin.toFixed(
            2
          )}. Available: $\${cash.toFixed(2)}\`,
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        handleRejectProposal(proposal.id, "Insufficient Margin");
        return;
      }

      setProposalQueue((prev) => prev.filter((p) => p.id !== proposal.id));

      const quantity = requiredMargin / proposal.currentPrice;

      // Make the actual API call to the backend executor
      try {
        const res = await fetch('/api/execute-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: proposal.symbol,
            side: proposal.direction,
            quantity: quantity,
            price: proposal.currentPrice,
            orderType: "MARKET",
            isPaperTrade: tapeMode === "SIMULATED TAPE"
          })
        });

        const result = await res.json();
        
        if (!result.success) {
           setExecutionToast({
            id: \`toast-\${Date.now()}\`,
            title: "Execution Failed",
            message: result.error || "Failed to execute on CoinDCX",
            type: "WARNING",
            timestamp: new Date().toLocaleTimeString(),
          });
          return;
        }

        const newPosition: Position = {
          id: result.orderId || \`POS-\${Date.now()}\`,
          symbol: proposal.symbol,
          direction: proposal.direction,
          entryPrice: result.executedPrice || proposal.currentPrice,
          quantity: quantity,
          unrealizedPnl: 0,
          unrealizedPnlPct: 0,
          status: "OPEN",
          setup: proposal.setup,
          confidence: proposal.confidence,
          stopLoss: proposal.stopLoss,
          takeProfit: proposal.takeProfit,
          timestamp: Date.now(),
        };

        setActivePositions((prev) => [...prev, newPosition]);
        setCash((prev) => prev - requiredMargin);

        logSecurityAudit(
          isAutonomousSelfApproved ? "AUTONOMOUS_EXECUTION" : "ORDER_EXECUTED",
          result.message + (result.signatureGenerated ? " Sig: " + result.signatureGenerated : "")
        );

        // Play execute sound
        try {
          const audio = new Audio("/sounds/execute.wav");
          audio.volume = 0.4;
          audio.play().catch(() => {});
        } catch (e) {}

        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Order Executed",
          message: \`\${result.message} \${proposal.direction} \${proposal.symbol}\`,
          type: "SUCCESS",
          timestamp: new Date().toLocaleTimeString(),
        });

      } catch (err: any) {
        setExecutionToast({
          id: \`toast-\${Date.now()}\`,
          title: "Network Error",
          message: "Failed to reach execution server.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
      }
    },
    [userRole, activePositions, cash, killSwitchActive, tapeMode]
  );`;

appContent = appContent.replace(oldApprove, newApprove);
fs.writeFileSync('src/App.tsx', appContent);
