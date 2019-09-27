const Client=require('ftp')

var ftp=new Client();
ftp.on('ready',function(){
    ftp.list(function(err,list){
        ftp.end();
        callback(err,list)
    })
})
exports.getDir=function(user,callback){
    
    ftp.connect({user:user.user,password:user.password});
}

exports.getFile=function(user,callback){
    
}