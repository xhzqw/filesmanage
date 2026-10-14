export function IconOrganization(){
 // Organization chart: clear silhouette at 18px, consistent Rare-style stroke.
 return <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
  aria-hidden="true" focusable="false">
  <rect x="9" y="2" width="6" height="5" rx="1.3"/>
  <path d="M12 7v5M5 12h14M5 12v3M19 12v3"/>
  <rect x="2" y="15" width="6" height="6" rx="1.3"/>
  <rect x="16" y="15" width="6" height="6" rx="1.3"/>
 </svg>;
}

export function IconUsers(){
 return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M11 14v-1.5a2.5 2.5 0 0 0-2.5-2.5h-5A2.5 2.5 0 0 0 1 12.5V14"/>
  <circle cx="6" cy="5" r="3"/>
  <path d="M15 14v-1.2a2.3 2.3 0 0 0-1.8-2.2"/>
  <path d="M11 2.2a2.3 2.3 0 0 1 0 4.5"/>
 </svg>;
}

export function IconSearch(){
 return <svg className="org-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <circle cx="7" cy="7" r="4.5"/>
  <path d="M10.5 10.5L14 14"/>
 </svg>;
}

export function IconChevron({open}:{open:boolean}){
 return <svg className={"org-chevron-svg"+(open?" open":"")} width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M6 3l5 5-5 5"/>
 </svg>;
}
