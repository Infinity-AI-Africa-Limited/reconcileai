/**
 * SLA Monitoring Service
 * Monitors exception resolution times and sends alerts when SLA thresholds are breached.
 */
import { notifyOwner } from "./_core/notification";
import * as db from "./db";

// SLA thresholds in hours
const SLA_WARNING_THRESHOLD = 20; // Yellow alert
const SLA_BREACH_THRESHOLD = 24; // Red alert

interface SLABreach {
  exceptionId: number;
  hoursOpen: number;
  severity: 'warning' | 'critical';
  assignedTo?: number;
  assignedUserName?: string;
}

/**
 * Check all open exceptions for SLA breaches and send notifications
 */
export async function checkSLABreaches(): Promise<void> {
  try {
    // Get all open and in-review exceptions
    const { data: exceptions } = await db.getExceptions({ 
      limit: 10000 
    });
    
    const openExceptions = exceptions.filter(
      (e: any) => e.status === 'open' || e.status === 'in_review'
    );
    
    const breaches: SLABreach[] = [];
    const now = new Date();
    
    for (const exception of openExceptions) {
      if (!exception.createdAt) continue;
      
      const hoursOpen = (now.getTime() - exception.createdAt.getTime()) / (1000 * 60 * 60);
      
      // Check if this exception has crossed a threshold
      if (hoursOpen >= SLA_BREACH_THRESHOLD) {
        // Get assigned user info if available
        let assignedUserName: string | undefined;
        if (exception.assignedTo) {
          const allUsers = await db.getAllUsers();
          const user = allUsers.find((u: any) => u.id === exception.assignedTo);
          assignedUserName = user?.name || user?.email || `User #${exception.assignedTo}`;
        }
        
        breaches.push({
          exceptionId: exception.id,
          hoursOpen: Math.round(hoursOpen * 10) / 10,
          severity: 'critical',
          assignedTo: exception.assignedTo || undefined,
          assignedUserName,
        });
      } else if (hoursOpen >= SLA_WARNING_THRESHOLD) {
        let assignedUserName: string | undefined;
        if (exception.assignedTo) {
          const allUsers = await db.getAllUsers();
          const user = allUsers.find((u: any) => u.id === exception.assignedTo);
          assignedUserName = user?.name || user?.email || `User #${exception.assignedTo}`;
        }
        
        breaches.push({
          exceptionId: exception.id,
          hoursOpen: Math.round(hoursOpen * 10) / 10,
          severity: 'warning',
          assignedTo: exception.assignedTo || undefined,
          assignedUserName,
        });
      }
    }
    
    // Send notifications if there are breaches
    if (breaches.length > 0) {
      await sendSLABreachNotification(breaches);
    }
    
    console.log(`[SLA Monitor] Checked ${openExceptions.length} exceptions, found ${breaches.length} SLA breaches`);
  } catch (error) {
    console.error('[SLA Monitor] Error checking SLA breaches:', error);
  }
}

/**
 * Send SLA breach notification to managers
 */
async function sendSLABreachNotification(breaches: SLABreach[]): Promise<void> {
  const criticalBreaches = breaches.filter(b => b.severity === 'critical');
  const warningBreaches = breaches.filter(b => b.severity === 'warning');
  
  let content = '## SLA Breach Alert\n\n';
  
  if (criticalBreaches.length > 0) {
    content += `### 🔴 Critical (>24 hours): ${criticalBreaches.length} exceptions\n\n`;
    criticalBreaches.slice(0, 10).forEach(breach => {
      const assignedInfo = breach.assignedUserName 
        ? `Assigned to: ${breach.assignedUserName}` 
        : 'Unassigned';
      content += `- Exception #${breach.exceptionId} - ${breach.hoursOpen}hrs open - ${assignedInfo}\n`;
    });
    if (criticalBreaches.length > 10) {
      content += `\n_...and ${criticalBreaches.length - 10} more critical exceptions_\n`;
    }
    content += '\n';
  }
  
  if (warningBreaches.length > 0) {
    content += `### ⚠️ Warning (>20 hours): ${warningBreaches.length} exceptions\n\n`;
    warningBreaches.slice(0, 10).forEach(breach => {
      const assignedInfo = breach.assignedUserName 
        ? `Assigned to: ${breach.assignedUserName}` 
        : 'Unassigned';
      const timeRemaining = 24 - breach.hoursOpen;
      content += `- Exception #${breach.exceptionId} - ${breach.hoursOpen}hrs open - ${timeRemaining.toFixed(1)}hrs remaining - ${assignedInfo}\n`;
    });
    if (warningBreaches.length > 10) {
      content += `\n_...and ${warningBreaches.length - 10} more warning exceptions_\n`;
    }
  }
  
  content += '\n---\n\n';
  content += `**Action Required:** Please review and resolve these exceptions to maintain SLA compliance.\n`;
  content += `**24-hour SLA Target:** All exceptions should be resolved within 24 hours of creation.\n`;
  
  await notifyOwner({
    title: `⚠️ SLA Breach Alert: ${breaches.length} Exception${breaches.length !== 1 ? 's' : ''} Require Attention`,
    content,
  });
}

/**
 * Start SLA monitoring with periodic checks
 * @param intervalMinutes How often to check for SLA breaches (default: 60 minutes)
 */
export function startSLAMonitoring(intervalMinutes: number = 60): NodeJS.Timeout {
  console.log(`[SLA Monitor] Starting with ${intervalMinutes}-minute interval`);
  
  // Run immediately on start
  checkSLABreaches();
  
  // Then run periodically
  return setInterval(() => {
    checkSLABreaches();
  }, intervalMinutes * 60 * 1000);
}
