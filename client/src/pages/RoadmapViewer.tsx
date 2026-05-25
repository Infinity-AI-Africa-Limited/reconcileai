import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Lock, AlertTriangle, Loader2 } from "lucide-react";

function getTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

export default function RoadmapViewer() {
  const [, navigate] = useLocation();
  const token = getTokenFromUrl();
  const [roadmapUrl, setRoadmapUrl] = useState<string | null>(null);

  const { data, isLoading, error } = trpc.roadmap.verifyToken.useQuery(
    { token: token ?? "" },
    {
      enabled: !!token,
      retry: false,
    }
  );

  useEffect(() => {
    if (data?.valid && data.roadmapKey) {
      setRoadmapUrl(`/manus-storage/${data.roadmapKey}`);
    }
  }, [data]);

  // No token in URL — redirect to request page
  if (!token) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center border border-red-500/20">
              <Lock className="w-8 h-8 text-red-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white">Access Required</h1>
          <p className="text-gray-400">
            This document is private. You need a valid access link to view it.
          </p>
          <Button
            onClick={() => navigate("/roadmap-access")}
            className="bg-[#f59e0b] hover:bg-[#d97706] text-black font-semibold px-8"
          >
            Request Access
          </Button>
        </div>
      </div>
    );
  }

  // Loading
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 text-[#f59e0b] animate-spin mx-auto" />
          <p className="text-gray-400">Verifying your access...</p>
        </div>
      </div>
    );
  }

  // Invalid / expired token
  if (error || !data?.valid) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-amber-500/10 rounded-2xl flex items-center justify-center border border-amber-500/20">
              <AlertTriangle className="w-8 h-8 text-amber-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white">Link Invalid or Expired</h1>
          <p className="text-gray-400">
            This access link is no longer valid. It may have expired or been revoked.
          </p>
          <Button
            onClick={() => navigate("/roadmap-access")}
            className="bg-[#f59e0b] hover:bg-[#d97706] text-black font-semibold px-8"
          >
            Request New Access
          </Button>
        </div>
      </div>
    );
  }

  // Approved — render the roadmap in a full-screen iframe
  return (
    <div className="flex flex-col min-h-screen bg-[#0a0f1e]">
      {/* Thin top bar */}
      <div className="flex items-center justify-between px-6 py-2 bg-[#111827] border-b border-[#1e2d4a] shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 bg-[#f59e0b] rounded flex items-center justify-center">
            <span className="text-black text-xs font-bold">R</span>
          </div>
          <span className="text-white font-semibold text-sm">ReconcileAI — GTM Execution Roadmap</span>
          <span className="text-gray-500 text-xs">· July 2026 → June 2027</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-gray-400 text-xs">Viewing as <span className="text-white">{data.name}</span></span>
          <span className="bg-emerald-500/20 text-emerald-400 text-xs px-2 py-0.5 rounded-full border border-emerald-500/30">
            Confidential
          </span>
        </div>
      </div>

      {/* Roadmap iframe */}
      {roadmapUrl && (
        <iframe
          src={roadmapUrl}
          className="flex-1 w-full border-0"
          title="ReconcileAI GTM Execution Roadmap"
          sandbox="allow-scripts allow-same-origin"
        />
      )}
    </div>
  );
}
