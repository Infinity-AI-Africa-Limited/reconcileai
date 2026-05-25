import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, Lock, FileText, Clock } from "lucide-react";

export default function RoadmapAccess() {
  const [form, setForm] = useState({ name: "", email: "", company: "", reason: "" });
  const [submitted, setSubmitted] = useState<"pending" | "already_pending" | "already_approved" | null>(null);
  const [approvedToken, setApprovedToken] = useState<string | null>(null);

  const requestAccess = trpc.roadmap.requestAccess.useMutation({
    onSuccess: (data) => {
      setSubmitted(data.status as "pending" | "already_pending" | "already_approved");
      if (data.status === "already_approved" && data.token) {
        setApprovedToken(data.token);
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) return;
    requestAccess.mutate(form);
  };

  if (submitted === "already_approved" && approvedToken) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center p-6">
        <Card className="max-w-md w-full bg-[#111827] border-[#1e2d4a] text-white">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <CheckCircle className="w-16 h-16 text-emerald-400" />
            </div>
            <CardTitle className="text-2xl text-white">Access Already Granted</CardTitle>
            <CardDescription className="text-gray-400">
              Your email already has approved access to the roadmap.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button
              className="w-full bg-[#f59e0b] hover:bg-[#d97706] text-black font-semibold"
              onClick={() => window.location.href = `/roadmap?token=${approvedToken}`}
            >
              View Roadmap Now
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted === "pending" || submitted === "already_pending") {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center p-6">
        <Card className="max-w-md w-full bg-[#111827] border-[#1e2d4a] text-white">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <Clock className="w-16 h-16 text-[#f59e0b]" />
            </div>
            <CardTitle className="text-2xl text-white">Request Received</CardTitle>
            <CardDescription className="text-gray-400 text-base mt-2">
              {submitted === "already_pending"
                ? "We already have a pending request from your email address."
                : "Your access request has been submitted successfully."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-gray-300 text-sm leading-relaxed">
              Our team will review your request and send you a private access link via email within 24 hours.
            </p>
            <div className="bg-[#1e2d4a]/50 rounded-lg p-4 text-left space-y-2">
              <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">What happens next</p>
              <div className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-[#f59e0b] font-bold mt-0.5">1.</span>
                <span>Your request is reviewed by the Infinity AI team</span>
              </div>
              <div className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-[#f59e0b] font-bold mt-0.5">2.</span>
                <span>You receive a private access link at your email address</span>
              </div>
              <div className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-[#f59e0b] font-bold mt-0.5">3.</span>
                <span>The link gives you 30-day access to the full roadmap</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center p-6">
      <div className="max-w-lg w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-[#f59e0b]/10 rounded-2xl flex items-center justify-center border border-[#f59e0b]/20">
              <FileText className="w-8 h-8 text-[#f59e0b]" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-white">ReconcileAI</h1>
          <p className="text-[#f59e0b] font-semibold text-lg">12-Month GTM Execution Roadmap</p>
          <p className="text-gray-400 text-sm max-w-sm mx-auto">
            This document is confidential. Request access below and our team will send you a private link within 24 hours.
          </p>
        </div>

        {/* Access notice */}
        <div className="flex items-center gap-3 bg-[#1e2d4a]/50 border border-[#1e2d4a] rounded-lg px-4 py-3">
          <Lock className="w-4 h-4 text-[#f59e0b] shrink-0" />
          <p className="text-gray-300 text-sm">
            Access is granted individually. Each approved link is valid for 30 days.
          </p>
        </div>

        {/* Form */}
        <Card className="bg-[#111827] border-[#1e2d4a]">
          <CardHeader>
            <CardTitle className="text-white text-xl">Request Access</CardTitle>
            <CardDescription className="text-gray-400">
              Fill in your details and we'll review your request promptly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-gray-300">Full Name <span className="text-red-400">*</span></Label>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Richard Anwanakak"
                    className="bg-[#0a0f1e] border-[#1e2d4a] text-white placeholder:text-gray-600 focus:border-[#f59e0b]"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-gray-300">Email Address <span className="text-red-400">*</span></Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="you@company.com"
                    className="bg-[#0a0f1e] border-[#1e2d4a] text-white placeholder:text-gray-600 focus:border-[#f59e0b]"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="company" className="text-gray-300">Organisation</Label>
                <Input
                  id="company"
                  value={form.company}
                  onChange={e => setForm(f => ({ ...f, company: e.target.value }))}
                  placeholder="Bank, Fintech, VC firm..."
                  className="bg-[#0a0f1e] border-[#1e2d4a] text-white placeholder:text-gray-600 focus:border-[#f59e0b]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reason" className="text-gray-300">Why are you requesting access?</Label>
                <Textarea
                  id="reason"
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="e.g. Due diligence for potential investment, partnership evaluation, customer research..."
                  className="bg-[#0a0f1e] border-[#1e2d4a] text-white placeholder:text-gray-600 focus:border-[#f59e0b] min-h-[90px] resize-none"
                />
              </div>
              <Button
                type="submit"
                disabled={requestAccess.isPending || !form.name.trim() || !form.email.trim()}
                className="w-full bg-[#f59e0b] hover:bg-[#d97706] text-black font-semibold h-11 text-base"
              >
                {requestAccess.isPending ? "Submitting..." : "Request Access"}
              </Button>
              {requestAccess.isError && (
                <p className="text-red-400 text-sm text-center">
                  {requestAccess.error?.message || "Something went wrong. Please try again."}
                </p>
              )}
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-gray-600 text-xs">
          ReconcileAI by Infinity AI Africa Ltd · reconcileai.vip
        </p>
      </div>
    </div>
  );
}
