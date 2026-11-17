/**
 * BeeZilla's experts and the skills each one covers — one list for the Experts page
 * and for Talk's search (Skills). Plain data: window.BZ_EXPERTS, window.BZ_EXPERT_ICONS.
 */
(function () {
  var EXPERTS = [
    { id: "legal", name: "Legal", blurb: "Letters, agreements, notices — not legal advice.", skills: ["Demand letters and payment reminders", "Simple contracts and contractor agreements", "Landlord notices and roommate agreements", "NDAs and release forms", "Dispute and appeal letters", "Plain-English summaries of legal documents"] },
    { id: "medical", name: "Medical", blurb: "Insurance questions, billing disputes, patient rights.", skills: ["Insurance denial and appeal letters", "Explanation-of-benefits walkthroughs", "Medical bill review and negotiation scripts", "Records request letters", "Patient-rights explainers", "Understanding your coverage"] },
    { id: "software", name: "Software", blurb: "Debugging, architecture, code reviews, best practices.", skills: ["Debugging and root-cause writeups", "Architecture and design reviews", "Code review checklists", "Refactoring plans", "Best-practice and security guidance", "Readable technical docs"] },
    { id: "technology", name: "Technology", blurb: "Hardware, infrastructure, deployment, ops.", skills: ["Infrastructure and hosting explainers", "Deployment runbooks", "Vendor and tool selection", "Migration plans", "Ops and maintenance checklists", "Plain-language tech specs for non-experts"] },
    { id: "accounting", name: "Accounting", blurb: "Budgets, invoices, tax questions, financial planning.", skills: ["Invoice and late-fee policy templates", "Monthly budget and cash-flow forecasts", "Rate cards and pricing guidance", "Aging-report and collection templates", "Tax-season prep checklists", "Financial planning explainers"] },
    { id: "home", name: "Home & Contractors", blurb: "Repairs, renovations, hiring help, comparing quotes, permits.", skills: ["Scope-of-work documents for quotes", "Quote comparison sheets", "Contractor vetting checklists", "Permit and licensing guidance", "Renovation planning", "Hiring and handover documents"] },
    { id: "career", name: "Career & Work", blurb: "Resumes, cover letters, job disputes, workplace communication.", skills: ["Resumes and cover letters", "Negotiation and counter-offer scripts", "Workplace dispute letters", "Performance-review preparation", "Job-search plans", "Professional email templates"] },
    { id: "insurance", name: "Insurance", blurb: "Claims, denials, appeal letters, understanding your coverage.", skills: ["Claim and denial appeal letters", "Policy explainers", "Coverage comparison", "Damage documentation checklists", "Escalation letters", "Understanding what you're covered for"] },
    { id: "government", name: "Government & Forms", blurb: "DMV, benefits, permits, citizenship paperwork, complaints.", skills: ["Form-completion walkthroughs", "Permit and license guidance", "Benefits application help", "Complaint letters", "Citizenship and immigration paperwork explainers", "Deadline and doc checklists"] },
    { id: "education", name: "Education", blurb: "School disputes, IEP/504 plans, applications, financial aid.", skills: ["IEP and 504 request letters", "School dispute correspondence", "Application and essay guidance", "Financial-aid explainers", "Advocacy talking points", "Meeting-preparation checklists"] },
    { id: "landlord", name: "Landlord & Tenant", blurb: "Leases, deposits, repairs, eviction questions, notices.", skills: ["Lease and room-rental agreements", "Security-deposit returns and letters", "Repair request notices", "Eviction and notice guidance", "Move-in/move-out checklists", "Tenant rights explainers"] },
    { id: "travel", name: "Travel", blurb: "Refunds, cancellations, disputes with airlines and hotels.", skills: ["Refund and cancellation requests", "Airline and hotel dispute letters", "Chargeback documentation", "Itinerary-change planning", "Rights explainers for travelers", "Escalation templates"] }
  ];
  var ICONS = {
    legal: "⚖️", medical: "🩺", software: "💻", technology: "🖥️",
    accounting: "📊", home: "🏠", career: "💼", insurance: "🛡️",
    government: "📋", education: "🎓", landlord: "🏘️", travel: "✈️"
  };
  window.BZ_EXPERTS = EXPERTS;
  window.BZ_EXPERT_ICONS = ICONS;
})();
