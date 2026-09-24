// @ts-nocheck
import React, { Component, ReactNode, ErrorInfo } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-canvas text-ink font-ui p-5 flex flex-col gap-4 max-w-lg mx-auto">
          <h1 className="m-0 mt-8 font-display text-[28px] font-semibold">Something went wrong</h1>
          <p className="m-0 text-[15px] text-muted leading-relaxed">
            The desk hit an error and stopped drawing this screen. Open positions are still guarded on the server.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="self-start min-h-12 px-5 rounded-full bg-accent text-on-accent font-semibold cursor-pointer"
          >
            Reload
          </button>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Error details</summary>
            <pre className="whitespace-pre-wrap mt-2">{this.state.error?.toString()}</pre>
            <pre className="whitespace-pre-wrap">{this.state.errorInfo?.componentStack}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
