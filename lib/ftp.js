const Client=require('ftp')

var ftp=new Client();

exports.getDir=function(user,callback){
    ftp.on('ready',function(){
        ftp.list(function(err,list){
            ftp.end();
            callback(err,list)
        })
    })
    ftp.connect({user:user.user,password:user.password});
}

exports.getFile=function(user,callback){
    
}