export type SealUserPermission={userId:string;displayName:string;canSign:boolean;canStamp:boolean};
export type SealAsset={id:string;kind:"personal"|"company";name:string;ownerId?:string;ownerName?:string;grantedUserIds?:string[];createdBy:string;sha256:string;active:boolean;createdAt:string};
export type FileSealMark={id:string;fileId:string;versionSeq:number;fileSha256:string;assetId:string;assetSha256:string;assetName:string;assetKind:"personal"|"company";signerId:string;signerName:string;pageNumber:number;x:number;y:number;width:number;height:number;angleDegrees:number;createdAt:string};
export type SealPlacement={assetId:string;versionSeq:number;fileSha256:string;password:string;pageNumber:number;x:number;y:number;width:number;height:number;angleDegrees:number};
