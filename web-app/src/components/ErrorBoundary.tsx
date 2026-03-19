import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  name?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[${this.props.name || 'Component'}] render error:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="glass p-4 rounded-xl text-center">
          <p className="text-sm text-danger font-medium">Something went wrong</p>
          <p className="text-xs text-slate mt-1">{this.state.error?.message || 'Unknown error'}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-2 px-3 py-1 text-xs font-medium rounded-lg border border-primary/20 text-primary hover:bg-primary/5 transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
