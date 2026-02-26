import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookOpen, FileText, Rocket, Code, Shield, HelpCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Link } from "wouter";

export default function Documentation() {
  const documentationSections = [
    {
      icon: Rocket,
      title: "Quick Start Guide",
      description: "Get up and running with ReconcileAI in minutes. Learn the basics of uploading data, creating reconciliation jobs, and managing exceptions.",
      file: "ReconcileAI_Quick_Start.md",
      color: "text-coral-500",
      bgColor: "bg-coral-50",
    },
    {
      icon: BookOpen,
      title: "User Guide",
      description: "Comprehensive documentation covering all platform features, workflows, and best practices for standard users and reconciliation teams.",
      file: "ReconcileAI_User_Guide.md",
      color: "text-navy-600",
      bgColor: "bg-navy-50",
    },
    {
      icon: Shield,
      title: "Administrator Guide",
      description: "Technical documentation for system administrators covering user management, module configuration, security, and performance monitoring.",
      file: "ReconcileAI_Admin_Guide.md",
      color: "text-purple-600",
      bgColor: "bg-purple-50",
    },
    {
      icon: Code,
      title: "API Documentation",
      description: "REST API reference for programmatic access to ReconcileAI functionality, including authentication, endpoints, and integration examples.",
      link: "/api-docs",
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
  ];

  const helpResources = [
    {
      title: "Video Tutorials",
      description: "Step-by-step video guides for common workflows",
      link: "#tutorials",
    },
    {
      title: "Knowledge Base",
      description: "Searchable articles and troubleshooting guides",
      link: "#knowledge-base",
    },
    {
      title: "Contact Support",
      description: "Get help from our technical support team",
      link: "#support",
    },
    {
      title: "Training Webinars",
      description: "Live and recorded training sessions",
      link: "#webinars",
    },
  ];

  const handleDownload = async (filename: string) => {
    try {
      toast.info(`Downloading ${filename}...`);
      
      // Fetch the file content from the server
      const response = await fetch(`/api/trpc/docs.download?input=${encodeURIComponent(JSON.stringify({ filename }))}`);      
      if (!response.ok) {
        throw new Error("Failed to fetch documentation");
      }
      
      const data = await response.json();
      const result = data.result.data;
      
      // Create a blob from the content
      const blob = new Blob([result.content], { type: result.contentType });
      const url = window.URL.createObjectURL(blob);
      
      // Create a temporary link and trigger download
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      toast.success(`${filename} downloaded successfully`);
    } catch (error) {
      toast.error(`Failed to download ${filename}`);
      console.error("Download error:", error);
    }
  };

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-navy-900 mb-2">Documentation</h1>
        <p className="text-gray-600">
          Comprehensive guides and resources to help you get the most out of ReconcileAI
        </p>
      </div>

      {/* Main Documentation Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {documentationSections.map((section) => {
          const Icon = section.icon;
          return (
            <Card key={section.title} className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-start gap-4">
                  <div className={`p-3 rounded-lg ${section.bgColor}`}>
                    <Icon className={`h-6 w-6 ${section.color}`} />
                  </div>
                  <div className="flex-1">
                    <CardTitle className="text-xl mb-2">{section.title}</CardTitle>
                    <CardDescription className="text-sm">
                      {section.description}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {section.file ? (
                  <div className="flex gap-3">
                    <Button
                      variant="default"
                      onClick={() => handleDownload(section.file!)}
                      className="flex-1"
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      Download Guide
                    </Button>
                    <Link href={`/docs/${section.file?.replace('.md', '')}`}>
                      <Button variant="outline">
                        View Online
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <Button
                    variant="default"
                    onClick={() => window.location.href = section.link!}
                    className="w-full"
                  >
                    View Documentation
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Help Resources */}
      <div>
        <h2 className="text-2xl font-bold text-navy-900 mb-4">Additional Resources</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {helpResources.map((resource) => (
            <Card key={resource.title} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-coral-500" />
                  {resource.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-600 mb-3">{resource.description}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.location.href = resource.link}
                  className="w-full"
                >
                  Learn More
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Quick Links */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Links</CardTitle>
          <CardDescription>
            Jump directly to commonly accessed documentation sections
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <h3 className="font-semibold text-sm text-navy-900">Getting Started</h3>
              <ul className="space-y-1 text-sm text-gray-600">
                <li>
                  <a href="#login" className="hover:text-coral-500 hover:underline">
                    Logging In
                  </a>
                </li>
                <li>
                  <a href="#upload" className="hover:text-coral-500 hover:underline">
                    Uploading Data
                  </a>
                </li>
                <li>
                  <a href="#create-job" className="hover:text-coral-500 hover:underline">
                    Creating Reconciliation Jobs
                  </a>
                </li>
                <li>
                  <a href="#exceptions" className="hover:text-coral-500 hover:underline">
                    Managing Exceptions
                  </a>
                </li>
              </ul>
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold text-sm text-navy-900">Advanced Features</h3>
              <ul className="space-y-1 text-sm text-gray-600">
                <li>
                  <a href="#modules" className="hover:text-coral-500 hover:underline">
                    Three-Module Architecture
                  </a>
                </li>
                <li>
                  <a href="#scheduling" className="hover:text-coral-500 hover:underline">
                    Scheduled Tasks
                  </a>
                </li>
                <li>
                  <a href="#api" className="hover:text-coral-500 hover:underline">
                    API Integration
                  </a>
                </li>
                <li>
                  <a href="#anomaly" className="hover:text-coral-500 hover:underline">
                    Anomaly Detection
                  </a>
                </li>
              </ul>
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold text-sm text-navy-900">Administration</h3>
              <ul className="space-y-1 text-sm text-gray-600">
                <li>
                  <a href="#user-mgmt" className="hover:text-coral-500 hover:underline">
                    User Management
                  </a>
                </li>
                <li>
                  <a href="#module-config" className="hover:text-coral-500 hover:underline">
                    Module Configuration
                  </a>
                </li>
                <li>
                  <a href="#security" className="hover:text-coral-500 hover:underline">
                    Security & Compliance
                  </a>
                </li>
                <li>
                  <a href="#troubleshooting" className="hover:text-coral-500 hover:underline">
                    Troubleshooting
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Support Contact */}
      <Card className="bg-gradient-to-r from-navy-50 to-coral-50">
        <CardHeader>
          <CardTitle>Need Help?</CardTitle>
          <CardDescription>
            Our support team is here to assist you with any questions or issues
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <h4 className="font-semibold text-sm mb-2">Email Support</h4>
              <p className="text-sm text-gray-600 mb-2">
                For general inquiries and troubleshooting assistance
              </p>
              <a
                href="mailto:support@reconcileai.com"
                className="text-sm text-coral-500 hover:underline"
              >
                support@reconcileai.com
              </a>
            </div>
            <div className="flex-1">
              <h4 className="font-semibold text-sm mb-2">Priority Support</h4>
              <p className="text-sm text-gray-600 mb-2">
                For urgent issues affecting production workflows
              </p>
              <Button variant="default" size="sm">
                Contact Priority Support
              </Button>
            </div>
            <div className="flex-1">
              <h4 className="font-semibold text-sm mb-2">Documentation Feedback</h4>
              <p className="text-sm text-gray-600 mb-2">
                Help us improve our documentation
              </p>
              <a
                href="mailto:docs@reconcileai.com"
                className="text-sm text-coral-500 hover:underline"
              >
                docs@reconcileai.com
              </a>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
