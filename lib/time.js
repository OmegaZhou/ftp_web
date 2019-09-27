function getTime() {
    var time = new Date();
    var time_str = '';
    time_str += time.getFullYear() + '/' + time.getMonth() + '/' + time.getDay() + ' ' +
            time.getHours() + ':' + time.getMinutes() + ':' + time.getSeconds();

    return time_str;
}
exports.getTime=getTime;