'use strict';

var fs = require('fs');
var path = require('path');
var { AuditLog } = require('./log');

/**
 * Audit-event control mapping A (internal id soc2). Report output names no framework.
 */
var SOC2_CONTROLS = {
  CC6_1: { name: 'Logical Access', description: 'Access to data and systems is restricted to authorized users' },
  CC6_2: { name: 'System Operations', description: 'System operations are monitored for anomalies' },
  CC6_3: { name: 'Change Management', description: 'Changes are authorized, tested, and approved before deployment' },
  CC7_1: { name: 'Risk Assessment', description: 'Risks are identified and mitigated' },
  CC7_2: { name: 'Monitoring', description: 'System components are monitored for anomalies' },
  CC8_1: { name: 'Incident Response', description: 'Security incidents are identified and responded to' },
};

/**
 * Audit-event control mapping B (internal id iso27001). Report output names no framework.
 */
var ISO27001_CONTROLS = {
  'A.9.2': { name: 'User Access Management', description: 'Formal access provisioning and de-provisioning' },
  'A.12.4': { name: 'Logging and Monitoring', description: 'Events are recorded and evidence is generated' },
  'A.12.5': { name: 'Control of Operational Software', description: 'Installation of software is controlled' },
  'A.14.2': { name: 'Security in Development', description: 'Security requirements in SDLC' },
  'A.16.1': { name: 'Incident Management', description: 'Consistent approach to security incidents' },
  'A.18.1': { name: 'Compliance', description: 'Compliance with legal and contractual requirements' },
};

/**
 * Map audit actions to mapping A controls.
 */
var ACTION_TO_SOC2 = {
  'agent_start': ['CC6_1', 'CC6_2'],
  'agent_stop': ['CC6_1', 'CC6_2'],
  'file_write': ['CC6_3', 'CC7_2'],
  'file_read': ['CC6_1'],
  'command_execute': ['CC6_3', 'CC7_2'],
  'deploy': ['CC6_3', 'CC8_1'],
  'policy_evaluate': ['CC7_1', 'CC7_2'],
  'approval_request': ['CC6_3'],
  'approval_resolve': ['CC6_3'],
  'test_run': ['CC6_3', 'CC7_1'],
};

/**
 * Map audit actions to mapping B controls.
 */
var ACTION_TO_ISO = {
  'agent_start': ['A.9.2', 'A.12.4'],
  'agent_stop': ['A.9.2', 'A.12.4'],
  'file_write': ['A.12.5', 'A.14.2'],
  'file_read': ['A.9.2'],
  'command_execute': ['A.12.5', 'A.14.2'],
  'deploy': ['A.12.5', 'A.14.2'],
  'policy_evaluate': ['A.18.1'],
  'approval_request': ['A.9.2', 'A.16.1'],
  'approval_resolve': ['A.9.2', 'A.16.1'],
  'test_run': ['A.14.2'],
};

/**
 * Generate an audit evidence report (mapping A) from audit log entries.
 *
 * @param {object[]} entries - Audit log entries
 * @param {object} [opts]
 * @param {string} [opts.projectName] - Project name for the report
 * @param {string} [opts.period] - Reporting period description
 * @returns {object} Structured audit evidence report
 */
function generateSoc2Report(entries, opts) {
  opts = opts || {};
  var controlEvidence = {};

  // Initialize all controls
  Object.keys(SOC2_CONTROLS).forEach(function (id) {
    controlEvidence[id] = {
      control: SOC2_CONTROLS[id],
      evidenceCount: 0,
      sampleEntries: [],
    };
  });

  // Map entries to controls
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var controls = ACTION_TO_SOC2[entry.what] || [];
    for (var j = 0; j < controls.length; j++) {
      var cid = controls[j];
      if (controlEvidence[cid]) {
        controlEvidence[cid].evidenceCount++;
        if (controlEvidence[cid].sampleEntries.length < 5) {
          controlEvidence[cid].sampleEntries.push({
            seq: entry.seq,
            timestamp: entry.timestamp,
            who: entry.who,
            what: entry.what,
          });
        }
      }
    }
  }

  return {
    reportType: 'AUDIT_EVIDENCE_REPORT',
    generatedAt: new Date().toISOString(),
    projectName: opts.projectName || 'Loki Mode',
    period: opts.period || 'Current',
    totalAuditEntries: entries.length,
    controls: controlEvidence,
    chainIntegrity: null, // Caller should set after verifyChain()
  };
}

/**
 * Generate an audit evidence report (mapping B) from audit log entries.
 */
function generateIso27001Report(entries, opts) {
  opts = opts || {};
  var controlEvidence = {};

  Object.keys(ISO27001_CONTROLS).forEach(function (id) {
    controlEvidence[id] = {
      control: ISO27001_CONTROLS[id],
      evidenceCount: 0,
      sampleEntries: [],
    };
  });

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var controls = ACTION_TO_ISO[entry.what] || [];
    for (var j = 0; j < controls.length; j++) {
      var cid = controls[j];
      if (controlEvidence[cid]) {
        controlEvidence[cid].evidenceCount++;
        if (controlEvidence[cid].sampleEntries.length < 5) {
          controlEvidence[cid].sampleEntries.push({
            seq: entry.seq,
            timestamp: entry.timestamp,
            who: entry.who,
            what: entry.what,
          });
        }
      }
    }
  }

  return {
    reportType: 'AUDIT_EVIDENCE_REPORT',
    generatedAt: new Date().toISOString(),
    projectName: opts.projectName || 'Loki Mode',
    period: opts.period || 'Current',
    totalAuditEntries: entries.length,
    controls: controlEvidence,
  };
}

/**
 * Generate a data processing record (mapping C) from audit log entries.
 */
function generateGdprReport(entries, opts) {
  opts = opts || {};

  // Extract unique data subjects (actors) and processing activities
  var subjects = {};
  var activities = {};
  var dataCategories = {};

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    subjects[entry.who] = (subjects[entry.who] || 0) + 1;
    activities[entry.what] = (activities[entry.what] || 0) + 1;

    // Categorize data types from metadata
    if (entry.metadata) {
      if (entry.metadata.dataType) {
        dataCategories[entry.metadata.dataType] = true;
      }
      if (entry.metadata.containsPii) {
        dataCategories['personal_data'] = true;
      }
    }
  }

  return {
    reportType: 'DATA_PROCESSING_RECORD',
    generatedAt: new Date().toISOString(),
    projectName: opts.projectName || 'Loki Mode',
    controller: opts.controller || 'Organization',
    purposes: ['Autonomous software development', 'Quality assurance', 'Deployment'],
    legalBasis: 'Legitimate interest (automated software development)',
    dataSubjects: Object.keys(subjects).map(function (s) {
      return { id: s, activityCount: subjects[s] };
    }),
    processingActivities: Object.keys(activities).map(function (a) {
      return { activity: a, count: activities[a] };
    }),
    dataCategories: Object.keys(dataCategories),
    retentionPolicy: opts.retentionDays ? opts.retentionDays + ' days' : 'Project lifetime',
    securityMeasures: [
      'Hash-chain tamper evidence on audit log',
      'Policy-based access controls',
      'Data residency enforcement',
    ],
  };
}

/**
 * Export a report as JSON string.
 */
function exportReportJson(report) {
  return JSON.stringify(report, null, 2);
}

module.exports = {
  generateSoc2Report: generateSoc2Report,
  generateIso27001Report: generateIso27001Report,
  generateGdprReport: generateGdprReport,
  exportReportJson: exportReportJson,
  SOC2_CONTROLS: SOC2_CONTROLS,
  ISO27001_CONTROLS: ISO27001_CONTROLS,
  ACTION_TO_SOC2: ACTION_TO_SOC2,
  ACTION_TO_ISO: ACTION_TO_ISO,
};
