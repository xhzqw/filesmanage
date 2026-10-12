export type ExtensionChange={from:string;to:string};

// A leading dot alone (.env) is a name, not a suffix. Trailing dots have no
// extension. Case-only changes do not change the effective file type.
export function fileExtension(name:string):string{
 const dot=name.lastIndexOf(".");
 return dot>0&&dot<name.length-1?name.slice(dot):"";
}

export function extensionChange(oldName:string,newName:string):ExtensionChange|null{
 const from=fileExtension(oldName.trim());
 const to=fileExtension(newName.trim());
 return from.toLowerCase()===to.toLowerCase()?null:{from,to};
}

export function displayExtension(extension:string):string{
 return extension||"无后缀";
}
